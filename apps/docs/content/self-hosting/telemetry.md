---
title: Telemetry
description: What Hearth, Relays, and browsers report over OpenTelemetry, and how to turn it off or send it to your own backend.
---

Hearth, every Relay, and signed-in browsers report traces and logs over
[OpenTelemetry](https://opentelemetry.io), so Kiln's maintainers can find errors
and slow spots.

> [!NOTE]
> Kiln's published images have a telemetry endpoint built in. An installation
> from the install script or `compose.yaml` reports to Kiln's maintainers until
> you turn it off or point it elsewhere.

## Turn it off

Set `OTEL_SDK_DISABLED=true` on each Relay. The platform Relay passes it to
Hearth, and browsers report through Hearth, so they stop too. With Compose, add
it to `.env` and run `docker compose up -d`; otherwise see
[Change a setting](/self-hosting#change-a-setting).

## Send it to your own backend

Any OTLP-over-HTTP backend works, such as Tempo and Loki. Set these on each
Relay:

| Variable | Default | Meaning |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Kiln's | Where to send. Nothing is sent without one. |
| `OTEL_EXPORTER_OTLP_HEADERS` | None | Such as `Authorization=Basic%20abc123`. Write a space as `%20` and `=` in a value as `%3D`. |
| `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER` | `otlp` | `none` stops traces or logs |
| `OTEL_METRICS_EXPORTER` | Off | `otlp` sends metrics too |
| `OTEL_TRACES_SAMPLER_ARG` | `0.05` | Share of traces kept, `0` to `1` |
| `OTEL_RESOURCE_ATTRIBUTES` | None | Added to everything, such as `deployment.environment.name=production` |
| `OTEL_SDK_DISABLED` | `false` | `true` turns telemetry off |

What you set replaces what the image built in. An invalid setting turns
telemetry off rather than stopping Hearth or the Relay.

## What's reported

Traces of requests and operations, logs including errors with their stack
trace, and, only when turned on, metrics: each Relay's memory and how full its
connection to Hearth is.

Each report names the service (`hearth` or `relay`), Kiln's version and
commit, and your `kiln.installation_id`. Browsers send through Hearth, so the
backend's credentials never leave it.
