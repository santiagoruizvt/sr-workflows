// SYNC: recorre los repos del usuario, detecta cuáles tienen el topic de
// suscripción y les abre (o actualiza) un PR con los workflows de templates/.
//
// Se ejecuta desde actions/github-script (ver .github/workflows/sync.yml).
// Variables de entorno:
//   TOPIC            topic de suscripción (default: workflows)
//   WORKFLOWS_REF    ref de este repo que usan los consumidores (default: main)
//   NOTES_PATH       archivo de release notes (default: RELEASE_NOTES.md)
//   DRY_RUN          "true" para solo reportar, sin escribir nada
//   ENFORCE_RULESET  "true" para crear un ruleset que exija el check de pre-release

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const SYNC_BRANCH = 'sr-workflows/sync';
const RULESET_NAME = 'sr-workflows: release gate';
const REQUIRED_CHECK = 'pre-release / validate';

function listTemplates(dir = TEMPLATES_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTemplates(full);
    return [path.relative(TEMPLATES_DIR, full).split(path.sep).join('/')];
  });
}

function render(content, vars) {
  return content.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => (key in vars ? vars[key] : match));
}

async function getFile(github, owner, repo, filePath, ref) {
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path: filePath, ref });
    if (Array.isArray(data) || data.type !== 'file') return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

function withNotesEntry(current, entry) {
  if (current === null) return `# Release Notes\n\n${entry}`;
  const lines = current.split('\n');
  if (lines[0].startsWith('# ')) {
    // Insertar después del título (y su línea en blanco, si la hay)
    const rest = lines.slice(1);
    while (rest.length && rest[0].trim() === '') rest.shift();
    return `${lines[0]}\n\n${entry}${rest.join('\n')}`;
  }
  return `${entry}${current}`;
}

async function upsertBranch(github, owner, repo, sha) {
  try {
    await github.rest.git.updateRef({ owner, repo, ref: `heads/${SYNC_BRANCH}`, sha, force: true });
  } catch (e) {
    if (e.status !== 422 && e.status !== 404) throw e;
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${SYNC_BRANCH}`, sha });
  }
}

async function ensureRuleset(github, owner, repo) {
  const rulesets = await github.paginate(github.rest.repos.getRepoRulesets, { owner, repo, per_page: 100 });
  if (rulesets.some(r => r.name === RULESET_NAME)) return 'existente';
  await github.rest.repos.createRepoRuleset({
    owner,
    repo,
    name: RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [{ context: REQUIRED_CHECK }],
        },
      },
    ],
  });
  return 'creado';
}

async function syncRepo({ github, core, repo, templates, cfg }) {
  const owner = repo.owner.login;
  const name = repo.name;
  const base = repo.default_branch;
  // Este mismo repo usa los workflows reutilizables locales (los de su propio commit),
  // así un PR a sr-workflows se valida con su propia versión.
  const isSelf = repo.full_name === cfg.workflowsRepo;
  const vars = {
    WORKFLOWS_REPO: cfg.workflowsRepo,
    DEFAULT_BRANCH: base,
    REUSABLE_PATH: isSelf ? './.github/workflows' : `${cfg.workflowsRepo}/.github/workflows`,
    REUSABLE_REF: isSelf ? '' : `@${cfg.ref}`,
  };

  const desired = templates.map(t => ({ path: t.path, content: render(t.content, vars) }));

  // Estado actual en la rama por defecto
  let baseSha;
  try {
    const { data } = await github.rest.git.getRef({ owner, repo: name, ref: `heads/${base}` });
    baseSha = data.object.sha;
  } catch (e) {
    if (e.status === 409 || e.status === 404) return { status: '⚠️ repo vacío, omitido' };
    throw e;
  }

  const current = await Promise.all(desired.map(f => getFile(github, owner, name, f.path, base)));
  const changed = desired.filter((f, i) => current[i] !== f.content);

  if (changed.length === 0) {
    let ruleset = '';
    if (cfg.enforce && !cfg.dryRun) {
      try {
        ruleset = ` · ruleset ${await ensureRuleset(github, owner, name)}`;
      } catch (e) {
        core.warning(`${repo.full_name}: no se pudo crear el ruleset (${e.status}): ${e.message}`);
        ruleset = ' · ⚠️ ruleset no aplicado';
      }
    }
    return { status: `✅ al día${ruleset}` };
  }

  // ¿Ya hay un PR abierto con exactamente estos archivos?
  const { data: openPrs } = await github.rest.pulls.list({
    owner, repo: name, state: 'open', head: `${owner}:${SYNC_BRANCH}`, base,
  });
  const existingPr = openPrs[0];
  if (existingPr) {
    const onBranch = await Promise.all(desired.map(f => getFile(github, owner, name, f.path, SYNC_BRANCH)));
    if (desired.every((f, i) => onBranch[i] === f.content)) {
      return { status: '⏳ PR pendiente de aprobación', pr: existingPr.html_url };
    }
  }

  const isUpdate = current.some(c => c !== null);
  const action = isUpdate ? 'actualizar' : 'incorporar';

  if (cfg.dryRun) {
    return { status: `🔍 dry-run: ${existingPr ? 'actualizaría' : 'abriría'} PR (${action}: ${changed.map(f => f.path).join(', ')})` };
  }

  // Release notes: el PR debe pasar su propio pre-release check
  const notesCurrent = await getFile(github, owner, name, cfg.notesPath, base);
  const notesEntry = isUpdate
    ? `## Workflows compartidos\n\n- Se actualizan los workflows gestionados por ${cfg.workflowsRepo}.\n\n`
    : `## Workflows compartidos\n\n- Se incorporan los workflows de pre-release y release automático gestionados por ${cfg.workflowsRepo}.\n\n`;
  const files = [...changed, { path: cfg.notesPath, content: withNotesEntry(notesCurrent, notesEntry) }];

  // Un único commit sobre la rama por defecto
  const { data: baseCommit } = await github.rest.git.getCommit({ owner, repo: name, commit_sha: baseSha });
  const { data: tree } = await github.rest.git.createTree({
    owner,
    repo: name,
    base_tree: baseCommit.tree.sha,
    tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
  });
  const { data: commit } = await github.rest.git.createCommit({
    owner,
    repo: name,
    message: `ci: ${action} workflows compartidos de ${cfg.workflowsRepo}`,
    tree: tree.sha,
    parents: [baseSha],
  });
  await upsertBranch(github, owner, name, commit.sha);

  const title = `ci: ${action} workflows compartidos #patch`;
  const body = [
    `PR generado automáticamente por el SYNC de [${cfg.workflowsRepo}](https://github.com/${cfg.workflowsRepo}).`,
    '',
    'Este repo tiene el topic `' + cfg.topic + '`, por lo que recibe los workflows compartidos:',
    '',
    ...changed.map(f => `- \`${f.path}\``),
    '',
    '**Qué implica:**',
    '- Todo PR a `' + base + '` deberá llevar `#major`, `#minor` o `#patch` en el título y actualizar `' + cfg.notesPath + '`.',
    '- Al mergear, se publica automáticamente un release `vX.Y.Z`.',
    '',
    'Para dejar de recibir estos PRs, quitá el topic `' + cfg.topic + '` del repo.',
  ].join('\n');

  if (existingPr) {
    await github.rest.pulls.update({ owner, repo: name, pull_number: existingPr.number, title, body });
    return { status: '🔄 PR actualizado', pr: existingPr.html_url };
  }
  const { data: pr } = await github.rest.pulls.create({ owner, repo: name, head: SYNC_BRANCH, base, title, body });
  return { status: '🆕 PR abierto', pr: pr.html_url };
}

module.exports = async ({ github, context, core }) => {
  const cfg = {
    topic: process.env.TOPIC || 'workflows',
    ref: process.env.WORKFLOWS_REF || 'main',
    notesPath: process.env.NOTES_PATH || 'RELEASE_NOTES.md',
    dryRun: process.env.DRY_RUN === 'true',
    enforce: process.env.ENFORCE_RULESET === 'true',
    workflowsRepo: `${context.repo.owner}/${context.repo.repo}`,
  };

  const templates = listTemplates().map(p => ({
    path: p,
    content: fs.readFileSync(path.join(TEMPLATES_DIR, p), 'utf8').replace(/\r\n/g, '\n'),
  }));
  core.info(`Plantillas: ${templates.map(t => t.path).join(', ')}`);

  const repos = (
    await github.paginate(github.rest.repos.listForAuthenticatedUser, { affiliation: 'owner', per_page: 100 })
  )
    .filter(r => !r.archived && !r.disabled)
    .sort((a, b) => a.name.localeCompare(b.name));

  const subscribed = repos.filter(r => (r.topics || []).includes(cfg.topic));
  const unsubscribed = repos.filter(r => !(r.topics || []).includes(cfg.topic));
  core.info(`${repos.length} repos: ${subscribed.length} suscriptos, ${unsubscribed.length} sin topic "${cfg.topic}".`);

  const rows = [];
  let failures = 0;
  for (const repo of subscribed) {
    try {
      const result = await syncRepo({ github, core, repo, templates, cfg });
      core.info(`${repo.full_name}: ${result.status}${result.pr ? ` ${result.pr}` : ''}`);
      rows.push([repo.full_name, result.status, result.pr ? `<a href="${result.pr}">PR</a>` : '']);
    } catch (e) {
      failures++;
      core.error(`${repo.full_name}: ${e.status || ''} ${e.message}`);
      rows.push([repo.full_name, `❌ ${e.status || ''} ${e.message}`, '']);
    }
  }

  await core.summary
    .addHeading(`SYNC${cfg.dryRun ? ' (dry-run)' : ''}`, 2)
    .addRaw(`Topic: <code>${cfg.topic}</code> · Ref: <code>${cfg.ref}</code>`, true)
    .addHeading(`Suscriptos (${subscribed.length})`, 3)
    .addTable([
      [{ data: 'Repo', header: true }, { data: 'Estado', header: true }, { data: 'PR', header: true }],
      ...rows,
    ])
    .addHeading(`Sin topic "${cfg.topic}" (${unsubscribed.length})`, 3)
    .addList(unsubscribed.map(r => r.full_name))
    .write();

  if (failures) core.setFailed(`${failures} repo(s) fallaron durante el SYNC.`);
};

module.exports.render = render;
module.exports.withNotesEntry = withNotesEntry;
module.exports.listTemplates = listTemplates;
