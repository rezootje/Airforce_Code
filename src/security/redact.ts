// Also removes OSC, CSI, bidi controls and other control characters from untrusted text.
export function sanitize(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}
export class Redactor {
  constructor(private readonly secrets: string[] = []) {}
  text(value: string): string {
    let result = value;
    for (const secret of this.secrets)
      if (secret.length > 3) result = result.split(secret).join('[REDACTED]');
    return result
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
        '[REDACTED PRIVATE KEY]',
      )
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{12,}|airf_oat_[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/g,
        '[REDACTED]',
      )
      .replace(
        /((?:api[_-]?key|access[_-]?token|secret|password|authorization)\s*["']?\s*[:=]\s*["']?)([^\s"',;}]{6,})/gi,
        '$1[REDACTED]',
      );
  }
  value<T>(value: T): T {
    return JSON.parse(this.text(JSON.stringify(value))) as T;
  }
}
export function sensitivePath(path: string): boolean {
  return /(?:^|[/\\])(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gnupg|\.kube|credentials(?:\.json)?|\.npmrc|\.netrc|id_rsa|id_ed25519|[^/\\]*\.(?:pem|key|p12|pfx))(?:[/\\]|$)/i.test(
    path,
  );
}

/** For already line-buffered event streams; retains private-key block state across events. */
export class StreamRedactor {
  private privateKey = false;
  constructor(private readonly redactor: Redactor) {}
  text(chunk: string): string {
    let output = '';
    for (const line of chunk.split(/(?<=\n)/)) {
      if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(line)) {
        this.privateKey = true;
        output += '[REDACTED PRIVATE KEY]\n';
      }
      if (this.privateKey) {
        if (/-----END [^-]*PRIVATE KEY-----/.test(line)) this.privateKey = false;
        continue;
      }
      output += this.redactor.text(line);
    }
    return sanitize(output);
  }
}
