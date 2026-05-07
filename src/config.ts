import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { configPath } from './paths.js';

const NagSchema = z
  .object({
    enabled: z.boolean().default(true),
    delay_minutes: z.number().int().min(1).max(480).default(60),
    interval_minutes: z.number().int().min(1).max(120).default(10),
    sound: z.string().default('Glass'),
  })
  .default({ enabled: true, delay_minutes: 60, interval_minutes: 10, sound: 'Glass' });

const ConfigSchema = z.object({
  username: z.string().min(1, 'username must be set — run `siesta login` to register your account'),
  presence_url: z
    .string()
    .url()
    .default('https://your-intranet.example/presence/PresenceController?actionName=presence&actionParm='),
  login_url: z.string().url().default('https://your-intranet.example/login/auth'),
  headless: z.boolean().default(true),
  timeout_ms: z.number().int().min(1000).max(120000).default(20000),
  nag: NagSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): { config: Config; path: string } {
  const p = configPath();
  if (!existsSync(p)) {
    throw new Error(`Config not found at ${p}. Run \`siesta config init\`.`);
  }
  const raw = readFileSync(p, 'utf8');
  const parsed = yaml.load(raw);
  const config = ConfigSchema.parse(parsed);
  return { config, path: p };
}

export function writeSampleConfig(): string {
  const p = configPath();
  if (existsSync(p)) {
    throw new Error(`Config already exists at ${p}`);
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, SAMPLE_CONFIG, 'utf8');
  return p;
}

const SAMPLE_CONFIG = `# siesta config
username: your.username      # intranet username — passwords live in macOS Keychain (run \`siesta login\`)

presence_url: https://your-intranet.example/presence/PresenceController?actionName=presence&actionParm=
login_url: https://your-intranet.example/login/auth

headless: true                    # flip to false (or pass --headed) when debugging
timeout_ms: 20000

nag:                              # Mittagspausen-Erinnerung: nach \`mahlzeit\` startet ein Hintergrund-Loop
  enabled: true
  delay_minutes: 60               # nach wie vielen Minuten Pause der erste Nag kommt
  interval_minutes: 10            # Takt der Folge-Nags, bis du wieder \`anwesend\` bist
  sound: Glass                    # macOS notification sound (z. B. Glass, Pop, Submarine, Hero, "")
`;
