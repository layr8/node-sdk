#!/usr/bin/env npx tsx
/**
 * Reads matrix.json and generates a docker-compose.yml with:
 * - Postgres (shared)
 * - One cloud-node service per version (port-mapped directly)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const matrixPath = resolve(__dirname, "matrix.json");
const outputPath = resolve(__dirname, "docker-compose.yml");

interface Matrix {
  image: string;
  versions: string[];
  basePort?: number;
}

const matrix: Matrix = JSON.parse(readFileSync(matrixPath, "utf-8"));

function serviceName(version: string): string {
  return `node-${version.replace(/\./g, "-")}`;
}

function generateCompose(matrix: Matrix): string {
  const services: Record<string, unknown> = {};
  const basePort = matrix.basePort ?? 4100;

  // Postgres
  services.postgres = {
    image: "postgres:16-alpine",
    environment: {
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "layr8_node",
    },
    healthcheck: {
      test: ["CMD-SHELL", "pg_isready -U postgres"],
      interval: "2s",
      timeout: "5s",
      retries: 10,
    },
  };

  // Migration service — runs migrations using the newest image
  const primaryVersion = matrix.versions[0];
  services.migrate = {
    image: `${matrix.image}:${primaryVersion}`,
    platform: "linux/amd64",
    environment: nodeEnv("migrate"),
    command: ["eval", "L8Server.Release.migrate(); System.halt(0)"],
    depends_on: { postgres: { condition: "service_healthy" } },
  };

  // Seed allowlist with wildcard entry so authorization allows all senders
  services.seed = {
    image: "postgres:16-alpine",
    environment: {
      PGPASSWORD: "postgres",
    },
    command: [
      "psql", "-h", "postgres", "-U", "postgres", "-d", "layr8_node", "-c",
      "INSERT INTO allowlist_entries (id, did, inserted_at, updated_at) VALUES ('00000000-0000-0000-0000-000000000001', '*', NOW(), NOW()) ON CONFLICT DO NOTHING;",
    ],
    depends_on: { migrate: { condition: "service_completed_successfully" } },
  };

  // Cloud-node services — each gets a unique host port
  for (let i = 0; i < matrix.versions.length; i++) {
    const version = matrix.versions[i];
    const name = serviceName(version);
    const hostPort = basePort + i;

    services[name] = {
      image: `${matrix.image}:${version}`,
      platform: "linux/amd64",
      environment: nodeEnv(name),
      ports: [`${hostPort}:4040`],
      healthcheck: {
        test: ["CMD", "wget", "--spider", "-q", "http://127.0.0.1:9000/readyz"],
        interval: "3s",
        timeout: "5s",
        retries: 20,
      },
      depends_on: {
        seed: { condition: "service_completed_successfully" },
      },
    };
  }

  return toYaml({ services });
}

function nodeEnv(name: string): Record<string, string> {
  return {
    DEPLOYMENT_ENV: "test",
    L8_NODE_DOMAIN_NAME: name,
    L8_NODE_DID_WEB_ALLOW_HTTP: "true",
    L8_NODE_DID_WEB_TARGET_SCHEME: "http",
    L8_NODE_DID_WEB_TARGET_PORT: "9000",
    DATABASE_HOST: "postgres",
    DATABASE_USER: "postgres",
    DATABASE_PASS: "postgres",
    DATABASE_PASSWORD: "postgres",
    DATABASE_NAME: "layr8_node",
    DATABASE_SSL: "false",
    SECRET_KEY_BASE: "test-secret-key-base-that-is-at-least-64-bytes-long-for-phoenix-framework-requirements-here",
    LIVE_VIEW_SIGNING_SALT: "test-salt",
    PHX_HOST: name,
    L8_NODE_PERSISTENCE_KEY: "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE",
    L8_PDP_ENABLED: "false",
    L8_DEFAULT_ALLOW_RULES: '["*"]',
    L8_NODE_GRPC_CLIENT_SSL: "false",
    L8_DIDCOMM_TRANSPORTS: "http",
  };
}

function toYaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return `${pad}null\n`;
  if (typeof obj === "string") {
    if (obj.includes("`") || obj.includes(":") || obj.includes("{") || obj.includes("[") || obj.includes("#") || obj.startsWith("!")) {
      return `${pad}"${obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
    }
    return `${pad}${obj}\n`;
  }
  if (typeof obj === "number" || typeof obj === "boolean") return `${pad}${obj}\n`;
  if (Array.isArray(obj)) {
    let out = "";
    for (const item of obj) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const inner = toYamlInline(item);
        out += `${pad}- ${inner}\n`;
      } else {
        const val = typeof item === "string" && (item.includes("`") || item.includes(":") || item.includes("{") || item.includes("["))
          ? `"${item.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
          : item;
        out += `${pad}- ${val}\n`;
      }
    }
    return out;
  }
  if (typeof obj === "object") {
    let out = "";
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof val === "object" && val !== null) {
        out += `${pad}${key}:\n${toYaml(val, indent + 1)}`;
      } else {
        out += `${pad}${key}: ${toYamlScalar(val)}\n`;
      }
    }
    return out;
  }
  return `${pad}${obj}\n`;
}

function toYamlScalar(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "string") {
    if (val.includes(":") || val.includes("`") || val.includes("{") || val.includes("[") || val.includes("#") || val.startsWith("!") || val === "true" || val === "false") {
      return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return val;
  }
  return String(val);
}

function toYamlInline(obj: Record<string, unknown>): string {
  const parts = Object.entries(obj).map(([k, v]) => `${k}: ${toYamlScalar(v)}`);
  return `{${parts.join(", ")}}`;
}

const output = generateCompose(matrix);
writeFileSync(outputPath, output);
console.log(`Generated ${outputPath}`);
