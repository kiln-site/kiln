---
title: Telemetry
description: What Hearth, Relays, and browsers report over OpenTelemetry, where it goes, and how to turn it off or send it to your own backend.
---

Hearth, every Relay, and signed-in browsers can report traces, logs, and
metrics over [OpenTelemetry](https://opentelemetry.io). Kiln's maintainers use
them to find errors and slow spots.

> [!NOTE]
> Kiln's published images come with a telemetry endpoint built in, so an
> installation from `kiln.site/install` or Kiln's `compose.yaml` reports to
> Kiln's maintainers until you turn it off or point it elsewhere.

## Turn it off

Set `OTEL_SDK_DISABLED=true` on each Relay. On the machine that runs Hearth,
setting it on the platform Relay turns it off for Hearth too, since the Relay
passes `OTEL_*` variables on to Hearth. Browsers report through Hearth, so they
stop with it.

With Compose, add it to `.env`:

```sh title=".env"
OTEL_SDK_DISABLED=true
```

and run `docker compose up -d`. See
[Change a setting](/self-hosting/configuration#change-a-setting) for an
install from the script, and set it the same way on the Relays you added.

## Send it to your own backend

Any backend that takes OTLP over HTTP works, such as Grafana's Tempo and Loki,
or an OpenTelemetry Collector. Set these on each Relay; the platform Relay
passes them on to Hearth.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Kiln's, in published images | Where to send telemetry. Nothing is sent without an endpoint. |
| `OTEL_EXPORTER_OTLP_HEADERS` | None | Headers to send, such as `Authorization=Basic%20abc123`. Write a space as `%20` and `=` inside a value as `%3D`. |
| `OTEL_TRACES_EXPORTER` | `otlp` | `none` stops traces |
| `OTEL_LOGS_EXPORTER` | `otlp` | `none` stops logs |
| `OTEL_METRICS_EXPORTER` | Off | `otlp` sends metrics too |
| `OTEL_TRACES_SAMPLER_ARG` | `0.05` | Share of traces kept, from `0` to `1` |
| `OTEL_RESOURCE_ATTRIBUTES` | None | Attributes added to everything, such as `deployment.environment.name=production` |
| `OTEL_SDK_DISABLED` | `false` | `true` turns telemetry off |

Published images can build in their own value for any of these, as Kiln's do
for the endpoint. Variables you set replace them. An invalid setting turns
telemetry off rather than stopping Hearth or the Relay.

## What Kiln reports

- **Traces** of requests and operations, such as a Relay starting a game
  server. A share of them is kept, 5% unless the image or
  `OTEL_TRACES_SAMPLER_ARG` says otherwise.
- **Logs**, including errors with their type, message, and stack trace, and a
  fingerprint that groups repeats of the same error.
- **Metrics**, only with `OTEL_METRICS_EXPORTER=otlp`: each Relay's memory use,
  and how full the connections between Hearth and each Relay are.

Each report says where it came from: the service (`hearth` or `relay`), Kiln's
version and source commit, and your installation's ID, `kiln.installation_id`.

Browsers send their traces and errors to Hearth, which forwards them with its
own settings. Only signed-in browsers can, and the backend's credentials never
leave Hearth.
