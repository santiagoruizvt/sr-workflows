# sr-workflows

Contiene workflows reutilizables que pueden ser consumidos por todos los repositorios.

## Cómo funciona

```
sr-workflows                                    repo con topic "workflows"
├── .github/workflows/
│   ├── reusable-pre-release.yml ◄──uses──  .github/workflows/pre-release.yml
│   ├── reusable-release.yml     ◄──uses──  .github/workflows/release.yml
│   └── sync.yml             ── abre PR ────►  (copia de templates/)
├── templates/           plantillas que se instalan en cada repo suscripto
└── scripts/sync.js      lógica del SYNC
```

Los repos consumidores solo tienen un "caller" de pocas líneas; la lógica vive acá.
Un cambio en los workflows reutilizables impacta a todos los repos sin abrir PRs.
Solo cuando cambian las `templates/` el SYNC abre PRs nuevos.

### Suscribirse

Agregar el topic **`workflows`** al repo (Settings → About → Topics). En la próxima corrida
del SYNC se abre un PR `ci: incorporar workflows compartidos #patch` que queda pendiente de
aprobación. Para desuscribirse, quitar el topic.

## Workflows

### Pre-release (`pre-release / validate`)

Corre en cada PR a la rama por defecto y falla si:

- el título no tiene exactamente una etiqueta `#major`, `#minor` o `#patch`;
- el PR no agrega líneas a `RELEASE_NOTES.md`.

> Para que **bloquee el merge**, el check `pre-release / validate` tiene que ser requerido
> en la rama por defecto. El SYNC lo configura solo si `ENFORCE_RULESET=true` (ver abajo);
> si no, hay que agregarlo a mano en Settings → Rules → Rulesets.

### Release

Al mergear un PR en la rama por defecto:

1. Busca el último tag `vX.Y.Z` (si no hay, parte de `v0.0.0`).
2. Incrementa según el título: `#major` → `X+1.0.0`, `#minor` → `X.Y+1.0`, `#patch` → `X.Y.Z+1`.
3. Publica un GitHub Release con ese tag; el cuerpo son las líneas agregadas a `RELEASE_NOTES.md` en el PR.

Convención recomendada para `RELEASE_NOTES.md`: entradas nuevas arriba.

```markdown
# Release Notes

## Login con Google

- Se agrega login con Google.
- Se corrige el timeout de sesión.
```

### SYNC

Corre los lunes, manualmente (Actions → SYNC → Run workflow, con opción *dry-run*) y
ante cambios en `templates/`. Para cada repo propio (no archivado):

| Situación                                  | Acción                              |
|--------------------------------------------|-------------------------------------|
| Sin topic `workflows`                      | Solo se lista en el resumen         |
| Con topic, workflows al día                | Nada (o crea el ruleset, si aplica) |
| Con topic, faltan/desactualizados          | Abre PR desde `sr-workflows/sync`   |
| Con topic, PR ya abierto y al día          | Nada, queda pendiente               |
| Con topic, PR abierto pero desactualizado  | Actualiza el PR                     |

El PR incluye una entrada en `RELEASE_NOTES.md` y `#patch` en el título, así pasa su propio
check. El resultado se ve en el *summary* de la corrida.

## Configuración

| Tipo     | Nombre            | Descripción                                                  |
|----------|-------------------|--------------------------------------------------------------|
| Secret   | `SYNC_TOKEN`      | PAT con acceso a todos los repos (ver permisos abajo)        |
| Variable | `ENFORCE_RULESET` | `true` para crear el ruleset que exige el check (opcional)   |
| Variable | `WORKFLOWS_REF`   | Ref que usan los consumidores, ej. `v1` (default `main`)     |
| Variable | `SYNC_TOPIC`      | Topic de suscripción (default `workflows`)                   |

**`SYNC_TOKEN`** — Fine-grained PAT, *Repository access: All repositories*, permisos:

- Contents: Read and write
- Pull requests: Read and write
- Workflows: Read and write
- Metadata: Read
- Administration: Read and write *(solo si `ENFORCE_RULESET=true`)*

El ruleset se crea recién cuando los workflows ya están en la rama por defecto (después de
mergear el PR del SYNC), para no bloquear PRs abiertos que todavía no corren el check.
En repos **privados** con plan Free, GitHub no aplica rulesets.

Si este repo es **privado**, habilitar Settings → Actions → General → *Access*:
"Accessible from repositories owned by the user" para que los demás repos puedan usarlo.

### Auto-suscripción

Este repo también puede tener el topic `workflows`. En ese caso el SYNC le instala los
mismos callers (`pre-release.yml`, `release.yml`), pero apuntando a los reutilizables
**locales** (`./.github/workflows/reusable-*.yml`): cada PR acá se valida con la versión de
los workflows de ese mismo PR, y cada merge genera un release `vX.Y.Z` de sr-workflows.
Con esos tags, los consumidores pueden fijar una versión con `WORKFLOWS_REF` (ej. `v1.2.0`).
