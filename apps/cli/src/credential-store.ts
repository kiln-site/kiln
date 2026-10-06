import { spawn } from "node:child_process"
import { win32 as windowsPath } from "node:path"

import { Result } from "effect"

export const KILN_CREDENTIAL_SERVICE = "site.kiln.cli"

export interface CredentialManager {
  readonly id: string
  readonly label: string
  deletePassword(account: string, signal?: AbortSignal): Promise<boolean>
  getPassword(account: string, signal?: AbortSignal): Promise<string | null>
  setPassword(
    account: string,
    password: string,
    signal?: AbortSignal
  ): Promise<void>
}

export interface CredentialCommand {
  arguments: ReadonlyArray<string>
  executable: string
  input?: string
}

export interface CredentialCommandResult {
  exitCode: number
  stderr: string
  stdout: string
}

export type CredentialCommandRunner = (
  command: CredentialCommand,
  signal?: AbortSignal
) => Promise<CredentialCommandResult>

export function credentialManagersForPlatform(
  platform: NodeJS.Platform,
  run: CredentialCommandRunner
): ReadonlyArray<CredentialManager> {
  if (platform === "darwin") return [macosKeychainCredentialManager(run)]
  if (platform === "win32") return [windowsCredentialManager(run)]
  return []
}

function macosKeychainCredentialManager(
  run: CredentialCommandRunner
): CredentialManager {
  const command = (
    operation: "delete" | "get" | "set",
    account: string,
    password?: string
  ): CredentialCommand => ({
    arguments: ["-l", "JavaScript", "-e", MACOS_KEYCHAIN_SCRIPT],
    executable: "/usr/bin/osascript",
    input: JSON.stringify({
      account,
      operation,
      password,
      service: KILN_CREDENTIAL_SERVICE,
    }),
  })
  return {
    id: "macos-keychain-v1",
    label: "macOS Keychain",
    deletePassword: async (account, signal) => {
      const result = await run(command("delete", account), signal)
      if (result.exitCode !== 0) {
        throw credentialCommandFailure("delete a macOS Keychain credential")
      }
      return parseMacosKeychainResult(result.stdout).deleted === true
    },
    getPassword: async (account, signal) => {
      const result = await run(command("get", account), signal)
      if (result.exitCode !== 0) {
        throw credentialCommandFailure("read a macOS Keychain credential")
      }
      return parseMacosKeychainResult(result.stdout).password ?? null
    },
    setPassword: async (account, password, signal) => {
      const result = await run(command("set", account, password), signal)
      if (result.exitCode !== 0) {
        throw credentialCommandFailure("store a macOS Keychain credential")
      }
    },
  }
}

function windowsCredentialManager(
  run: CredentialCommandRunner
): CredentialManager {
  const target = (account: string) => `${KILN_CREDENTIAL_SERVICE}:${account}`
  return {
    id: "windows-credential-manager-v1",
    label: "Windows Credential Manager",
    deletePassword: async (account, signal) => {
      const result = await run(
        powershellCommand(
          WINDOWS_DELETE_SCRIPT,
          JSON.stringify({ target: target(account) })
        ),
        signal
      )
      if (result.exitCode === 0) return true
      if (result.exitCode === 44) return false
      throw credentialCommandFailure(
        "delete a Windows Credential Manager entry"
      )
    },
    getPassword: async (account, signal) => {
      const result = await run(
        powershellCommand(
          WINDOWS_GET_SCRIPT,
          JSON.stringify({ target: target(account) })
        ),
        signal
      )
      if (result.exitCode === 44) return null
      if (result.exitCode !== 0) {
        throw credentialCommandFailure(
          "read a Windows Credential Manager entry"
        )
      }
      return trimTrailingLineBreak(result.stdout)
    },
    setPassword: async (account, password, signal) => {
      const result = await run(
        powershellCommand(
          WINDOWS_SET_SCRIPT,
          JSON.stringify({ account, password, target: target(account) })
        ),
        signal
      )
      if (result.exitCode !== 0) {
        throw credentialCommandFailure(
          "store a Windows Credential Manager entry"
        )
      }
    },
  }
}

export function runCredentialCommand(
  command: CredentialCommand,
  signal?: AbortSignal
): Promise<CredentialCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command.executable, command.arguments, {
      signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    const stdout: Array<Buffer> = []
    const stderr: Array<Buffer> = []
    let settled = false
    const finish = (result: CredentialCommandResult) => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", (cause) => {
      if (settled) return
      settled = true
      rejectPromise(cause)
    })
    child.once("close", (code) =>
      finish({
        exitCode: code ?? 1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      })
    )
    child.stdin.end(command.input ?? "")
  })
}

const MACOS_KEYCHAIN_SCRIPT = String.raw`
ObjC.import("Foundation")
ObjC.import("Security")
ObjC.bindFunction("SecItemAdd", ["int", ["id", "id *"]])
ObjC.bindFunction("SecItemCopyMatching", ["int", ["id", "id *"]])

const inputData = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
const inputText = ObjC.unwrap(
  $.NSString.alloc.initWithDataEncoding(inputData, $.NSUTF8StringEncoding)
)
const input = JSON.parse(inputText)
const itemNotFound = Number($.errSecItemNotFound)

function dictionary() {
  return $.NSMutableDictionary.dictionary
}

function itemQuery() {
  const query = dictionary()
  query.setObjectForKey($("genp"), $("class"))
  query.setObjectForKey($(input.account), $("acct"))
  query.setObjectForKey($(input.service), $("svce"))
  return query
}

function passwordData() {
  return $(input.password).dataUsingEncoding($.NSUTF8StringEncoding)
}

function ensureSuccess(status) {
  if (status !== Number($.errSecSuccess)) {
    throw new Error("Keychain Services failed with status " + status)
  }
}

function main() {
  const query = itemQuery()

  if (input.operation === "set") {
    const updates = dictionary()
    updates.setObjectForKey(passwordData(), $("v_Data"))
    let status = Number($.SecItemUpdate(query, updates))
    if (status === itemNotFound) {
      const item = $.NSMutableDictionary.dictionaryWithDictionary(query)
      item.setObjectForKey(passwordData(), $("v_Data"))
      status = Number($.SecItemAdd(item, Ref()))
    }
    ensureSuccess(status)
    return JSON.stringify({ stored: true })
  }

  if (input.operation === "get") {
    query.setObjectForKey($.NSNumber.numberWithBool(true), $("r_Data"))
    const result = Ref()
    const status = Number($.SecItemCopyMatching(query, result))
    if (status === itemNotFound) return JSON.stringify({ password: null })
    ensureSuccess(status)
    const password = ObjC.unwrap(
      $.NSString.alloc.initWithDataEncoding(result[0], $.NSUTF8StringEncoding)
    )
    return JSON.stringify({ password })
  }

  if (input.operation === "delete") {
    const status = Number($.SecItemDelete(query))
    if (status === itemNotFound) return JSON.stringify({ deleted: false })
    ensureSuccess(status)
    return JSON.stringify({ deleted: true })
  }

  throw new Error("Unsupported Keychain operation")
}

main()
`

interface MacosKeychainResult {
  deleted?: boolean
  password?: string | null
}

function parseMacosKeychainResult(stdout: string): MacosKeychainResult {
  return Result.try(() => JSON.parse(stdout) as MacosKeychainResult).pipe(
    Result.getOrThrowWith(() =>
      credentialCommandFailure("parse a macOS Keychain response")
    )
  )
}

function powershellCommand(script: string, input: string): CredentialCommand {
  return {
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    executable: windowsPowerShellExecutable(),
    input,
  }
}

function windowsPowerShellExecutable(): string {
  const windowsDirectory =
    process.env.SystemRoot?.trim() ||
    process.env.WINDIR?.trim() ||
    String.raw`C:\Windows`
  return windowsPath.join(
    windowsDirectory,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  )
}

function credentialCommandFailure(operation: string): Error {
  return new Error(`Could not ${operation}.`)
}

function trimTrailingLineBreak(value: string): string {
  return value.replace(/\r?\n$/u, "")
}

const WINDOWS_NATIVE_TYPES = String.raw`
using System;
using System.Runtime.InteropServices;

namespace KilnCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  public static class NativeMethods {
    [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref Credential credential, UInt32 flags);

    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

    [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

    [DllImport("Advapi32.dll", SetLastError = false)]
    public static extern void CredFree(IntPtr buffer);
  }
}`

const WINDOWS_POWERSHELL_SETUP = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WINDOWS_NATIVE_TYPES}
'@
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
$Target = [string]$inputData.target
`

const WINDOWS_SET_SCRIPT = `${WINDOWS_POWERSHELL_SETUP}
$secret = [string]$inputData.password
$bytes = [Text.Encoding]::Unicode.GetBytes($secret)
$pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
$credential = New-Object KilnCredentialManager.Credential
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $pointer, $bytes.Length)
  $credential.Type = 1
  $credential.TargetName = $Target
  $credential.CredentialBlobSize = $bytes.Length
  $credential.CredentialBlob = $pointer
  $credential.Persist = 2
  $credential.UserName = [string]$inputData.account
  if (-not [KilnCredentialManager.NativeMethods]::CredWrite([ref]$credential, 0)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
} finally {
  [Array]::Clear($bytes, 0, $bytes.Length)
  for ($index = 0; $index -lt $bytes.Length; $index++) {
    [Runtime.InteropServices.Marshal]::WriteByte($pointer, $index, 0)
  }
  [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
}`

const WINDOWS_GET_SCRIPT = `${WINDOWS_POWERSHELL_SETUP}
$pointer = [IntPtr]::Zero
if (-not [KilnCredentialManager.NativeMethods]::CredRead($Target, 1, 0, [ref]$pointer)) {
  if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 44 }
  throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][KilnCredentialManager.Credential])
  $bytes = New-Object byte[] $credential.CredentialBlobSize
  try {
    [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
    [Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes))
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
} finally {
  [KilnCredentialManager.NativeMethods]::CredFree($pointer)
}`

const WINDOWS_DELETE_SCRIPT = `${WINDOWS_POWERSHELL_SETUP}
if (-not [KilnCredentialManager.NativeMethods]::CredDelete($Target, 1, 0)) {
  if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 44 }
  throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
}`
