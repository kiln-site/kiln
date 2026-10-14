import {
  relayConsoleCommandResultSchema,
  relayConsoleCompletionSchema,
} from "@workspace/contracts"
import type {
  RelayConsoleCompletion,
  RelayConsoleCommandResult,
} from "@workspace/contracts"

import { traceBrowser } from "@/lib/browser-telemetry"
import { relayConsoleOperationClient } from "@/lib/relay-console-operations"
import {
  completeRelayConsoleCommand,
  sendRelayConsoleCommand,
} from "@/server/relay"

export async function sendDirectRelayCommand(
  relayId: string,
  instanceId: string,
  command: string
): Promise<RelayConsoleCommandResult> {
  return traceBrowser(
    "Send Relay console command",
    {
      "kiln.operation": "websocket.console.command",
      "kiln.channel": "console",
    },
    async (span) => {
      const client = relayConsoleOperationClient(relayId, instanceId)
      if (!client) {
        span.setAttribute("kiln.transport", "hearth")
        return sendRelayConsoleCommand({
          data: { command, instanceId, relayId },
        })
      }
      span.setAttribute("kiln.transport", "direct")
      return relayConsoleCommandResultSchema.parse(
        await client.request("console.write", { command })
      )
    }
  )
}

export async function completeDirectRelayCommand(
  relayId: string,
  instanceId: string,
  input: string,
  cursor: number
): Promise<RelayConsoleCompletion> {
  return traceBrowser(
    "Complete Relay console command",
    {
      "kiln.operation": "websocket.console.completion",
      "kiln.channel": "console",
    },
    async (span) => {
      const client = relayConsoleOperationClient(relayId, instanceId)
      if (!client) {
        span.setAttribute("kiln.transport", "hearth")
        return completeRelayConsoleCommand({
          data: { cursor, input, instanceId, relayId },
        })
      }
      span.setAttribute("kiln.transport", "direct")
      return relayConsoleCompletionSchema.parse(
        await client.request("console.complete", { cursor, input })
      )
    }
  )
}
