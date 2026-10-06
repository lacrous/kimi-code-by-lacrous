import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

export interface PortalCaptureOptions {
  readonly outputPath: string;
  readonly gdbusPath?: string;
  readonly timeoutMs?: number;
}

export interface PortalCaptureResult {
  readonly path: string;
  readonly width: number;
  readonly height: number;
}

function run(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: error.message });
    });
  });
}

export async function captureViaGnomeShell(
  options: PortalCaptureOptions,
): Promise<PortalCaptureResult | undefined> {
  const gdbus = options.gdbusPath ?? 'gdbus';
  const result = await run(
    gdbus,
    [
      'call',
      '--session',
      '--dest',
      'org.gnome.Shell.Screenshot',
      '--object-path',
      '/org/gnome/Shell/Screenshot',
      '--method',
      'org.gnome.Shell.Screenshot.Screenshot',
      'false',
      'false',
      options.outputPath,
    ],
    options.timeoutMs ?? 20_000,
  );
  if (result.code !== 0) {
    return undefined;
  }
  return probePng(options.outputPath);
}

export async function captureViaImport(
  options: PortalCaptureOptions,
): Promise<PortalCaptureResult | undefined> {
  const result = await run(
    'import',
    ['-window', 'root', '-silent', options.outputPath],
    options.timeoutMs ?? 20_000,
  );
  if (result.code !== 0) {
    return undefined;
  }
  return probePng(options.outputPath);
}

async function probePng(path: string): Promise<PortalCaptureResult | undefined> {
  const result = await run('identify', ['-format', '%w %h', path], 10_000);
  if (result.code !== 0) {
    return undefined;
  }
  const [width, height] = result.stdout.trim().split(/\s+/);
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  if (!Number.isFinite(parsedWidth) || !Number.isFinite(parsedHeight)) {
    return undefined;
  }
  return { path, width: parsedWidth, height: parsedHeight };
}

export interface CaptureStrategy {
  readonly name: string;
  readonly attempt: () => Promise<PortalCaptureResult | undefined>;
}

export function captureStrategies(outputPath: string): readonly CaptureStrategy[] {
  return [
    { name: 'gnome-shell', attempt: () => captureViaGnomeShell({ outputPath }) },
    { name: 'imagemagick', attempt: () => captureViaImport({ outputPath }) },
  ];
}

export async function captureScreen(
  outputPath: string,
  attempts: readonly CaptureStrategy[] = captureStrategies(outputPath),
): Promise<{ result: PortalCaptureResult; strategy: string } | undefined> {
  const tried: string[] = [];
  for (const strategy of attempts) {
    const result = await strategy.attempt();
    if (result !== undefined) {
      return { result, strategy: strategy.name };
    }
    tried.push(strategy.name);
  }
  return undefined;
}

export async function saveBase64Png(
  path: string,
  base64: string,
): Promise<PortalCaptureResult | undefined> {
  await writeFile(path, Buffer.from(base64, 'base64'));
  return probePng(path);
}
