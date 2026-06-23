import { existsSync, realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SANDBOX_CONFIG, loadConfig, type ForkSandboxConfig } from "./config.js";

const RAW_SHELL_ARGS = new Set([
  "$PWD",
  "${TERM:-xterm-256color}",
  "${LANG:-C.UTF-8}",
  "${LC_ALL:-C.UTF-8}",
  "/etc/profiles/per-user/$USER/bin:/run/current-system/sw/bin:/nix/var/nix/profiles/default/bin",
]);

const CA_BUNDLE_SANDBOX_PATH = "/tmp/pi-fork-ca-bundle.crt";
const CA_BUNDLE_ENV_KEYS = [
  "SSL_CERT_FILE",
  "NIX_SSL_CERT_FILE",
  "GIT_SSL_CAINFO",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
];

function defaultCaBundleCandidates(): string[] {
  return [
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/certs/ca-bundle.crt",
    "/nix/var/nix/profiles/default/etc/ssl/certs/ca-bundle.crt",
  ];
}

export function resolveCaBundlePath(candidates: string[] = defaultCaBundleCandidates()): string | undefined {
  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return realpathSync(candidate);
    } catch {
      // Ignore broken symlinks and unreadable candidates.
    }
  }
  return undefined;
}

function caBundleBindArgs(caBundlePath: string | undefined): string[] {
  if (!caBundlePath) return [];
  return ["--ro-bind-try", caBundlePath, CA_BUNDLE_SANDBOX_PATH];
}

function caBundleEnvArgs(caBundlePath: string | undefined): string[] {
  if (!caBundlePath) return [];
  return CA_BUNDLE_ENV_KEYS.flatMap((key) => ["--setenv", key, CA_BUNDLE_SANDBOX_PATH]);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellArg(value: string): string {
  if (value === "$PWD") return '"$PWD"';
  if (RAW_SHELL_ARGS.has(value)) return value.includes("$") ? `"${value}"` : value;
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : shellQuote(value);
}

function resolveSandboxConfig(overrides: Partial<ForkSandboxConfig> = {}): ForkSandboxConfig {
  return { ...DEFAULT_SANDBOX_CONFIG, ...overrides };
}

function tmpDirArgs(tmpDir: string): string[] {
  if (["/tmp", "/var/tmp", "/tmp/home"].includes(tmpDir)) return [];
  return ["--dir", tmpDir];
}

export function buildBwrapArgs(sandboxConfig: Partial<ForkSandboxConfig> = {}): string[] {
  const config = resolveSandboxConfig(sandboxConfig);
  const caBundlePath = resolveCaBundlePath();
  return [
    "--die-with-parent",
    "--unshare-all",
    config.bashNetwork ? "--share-net" : "--unshare-net",
    "--new-session",
    "--ro-bind-try", "/nix", "/nix",
    "--ro-bind-try", "/usr", "/usr",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/etc/passwd", "/etc/passwd",
    "--ro-bind-try", "/etc/group", "/etc/group",
    "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
    ...(config.bashNetwork
      ? [
          "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
          "--ro-bind-try", "/etc/hosts", "/etc/hosts",
        ]
      : []),
    "--ro-bind-try", "/run/current-system", "/run/current-system",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    ...caBundleBindArgs(caBundlePath),
    "--tmpfs", "/var/tmp",
    ...tmpDirArgs(config.tmpDir),
    "--dir", "/tmp/home",
    "--ro-bind", "$PWD", "$PWD",
    "--chdir", "$PWD",
    "--clearenv",
    ...caBundleEnvArgs(caBundlePath),
    "--setenv", "HOME", "/tmp/home",
    "--setenv", "TMPDIR", config.tmpDir,
    "--setenv", "TERM", "${TERM:-xterm-256color}",
    "--setenv", "LANG", "${LANG:-C.UTF-8}",
    "--setenv", "LC_ALL", "${LC_ALL:-C.UTF-8}",
    "--setenv", "PATH", "/etc/profiles/per-user/$USER/bin:/run/current-system/sw/bin:/nix/var/nix/profiles/default/bin",
  ];
}

function renderBwrapCommand(args: string[], command: string): string {
  const renderedArgs = args.map((arg) => `  ${shellArg(arg)} \\`).join("\n");
  return `if ! command -v bwrap >/dev/null 2>&1; then
  echo "Fork agent: bwrap is required for bash sandboxing but was not found." >&2
  exit 126
fi

bwrap \\
${renderedArgs}
  bash -lc ${shellQuote(command)}`;
}

export function buildSandboxedCommand(
  command: string,
  sandboxConfig: Partial<ForkSandboxConfig> = {},
): string {
  return renderBwrapCommand(buildBwrapArgs(sandboxConfig), command);
}

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        block: true,
        reason: "Fork agent: file modification is not allowed.",
      };
    }

    if (event.toolName === "bash") {
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      event.input.command = buildSandboxedCommand(command, loadConfig(process.cwd()).sandbox);
    }

    return undefined;
  });
}
