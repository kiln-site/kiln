# Realtime data boundaries

Kiln uses TanStack DB as Hearth's reactive browser data layer. It does not
replace MySQL, Relay state, or high-frequency Relay streams.

## Authority

- Hearth owns durable collaborative intent, access, user preferences, and
  cross-Relay history.
- Relay owns machine identity, host-local execution, files, containers,
  resource observations, and the state required to continue safely while
  Hearth is unavailable.
- The browser owns unsaved interaction state, including dirty editor buffers.
- Each field has one authority. Copies identify their source revision or
  observation time and are treated as projections.

## Browser collections

- Collections are defined by business domain, never by screen or filter.
- Small control-plane collections may load eagerly. Large histories and
  catalogs load only the subsets requested by active views.
- TanStack Query remains the fetch and SSR hydration layer. Query Collections
  materialize its normalized rows and use existing server functions to persist
  mutations.
- Authorized Hearth events apply incremental direct writes. A missing event
  sequence refetches only the affected active collections.
- Console output, resource samples, file contents, editor buffers, and secrets
  never enter general-purpose collections.

## Performance and lifecycle

- One `QueryClient` and one dependent `DbClient` exist per SSR request or
  browser router session. They are never module-global.
- Components subscribe to the smallest live query that can render their view.
- Collection IDs include business scope. Filters, ordering, and pagination do
  not create additional collection instances.
- Authentication changes clean up the previous DB client before another
  user's collections can be materialized.
- Realtime payloads contain safe client DTOs only; encrypted credentials,
  hashes, tokens, and host paths are excluded at the source.

## Desired and observed state

Hearth-to-Relay resources follow the schedule deployment model: Hearth stores
the desired revision, Relay persists the applied projection, and Relay reports
the acknowledged revision and observed result. Immediate actions such as a
restart remain commands whose execution and recovery state belong to Relay.
