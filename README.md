# ELI Links — link-in-bio de @nccenglishlanguageinstitute

Página de enlaces del English Language Institute (North Central College) + panel de administración.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | La página pública (elincc.site). Todo su contenido vive en un bloque JSON editable dentro del mismo archivo. |
| `admin.html` | Panel de administración (elincc.site/admin.html). Login con clave, edición visual, vista previa en vivo y botón **Publish**. |
| `CNAME` | Dominio personalizado para GitHub Pages (`elincc.site`). |

Sitio en producción: repo `vinigarzon/eli` → GitHub Pages → dominio `elincc.site`.

## Puesta en marcha (ya realizada; referencia por si hay que repetirla)

1. **Repo**: repositorio `eli` (cuenta `vinigarzon`), archivos en la rama `main`.
2. **Pages**: Settings → Pages → "Deploy from a branch" → `main` / root.
3. **Dominio elincc.site**: Settings → Pages → Custom domain = `elincc.site` (archivo CNAME incluido). DNS en el proveedor del dominio:
   - 4 registros **A** para `@` (raíz): `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - 1 registro **CNAME** para `www` → `vinigarzon.github.io`
   - Con el dominio validado, activar **Enforce HTTPS**.
4. **Clave de acceso del admin**: GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token:
   - Repository access: **Only select repositories → eli**
   - Permissions: **Contents → Read and write** (nada más)
   - Copia la clave (`github_pat_…`) y compártela solo con quien deba administrar. Se puede revocar y regenerar cuando quieras.

## Uso diario (para cualquier persona, sin conocimientos técnicos)

1. Abrir `elincc.site/admin.html`
2. Usuario (`vinigarzon`) y repositorio (`eli`) ya vienen prellenados — solo escribir la clave de acceso
3. Editar textos, botones, orden, ocultar/mostrar, agregar secciones — con vista previa en vivo
4. Clic en **Publish changes** → el sitio se actualiza solo en ~1 minuto

## Pendientes marcados en el contenido

- Reemplazar el botón "Ask Us Anything" (mailto) por el **Webform oficial** cuando Rachel lo habilite.
- La card "Find Your Path" apunta a la landing del ELI; cuando el **Path Finder V2** esté publicado ahí, queda funcionando sola.
- Agregar card "View a Sample Class Schedule" cuando el PDF esté en Media.
