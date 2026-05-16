#!/usr/bin/env npx tsx
/**
 * Reads matrix.json and generates a docker-compose.yml with:
 * - Postgres (shared)
 * - Traefik reverse proxy (host port 80, routes *.localhost)
 * - One cloud-node service per version
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
}

const matrix: Matrix = JSON.parse(readFileSync(matrixPath, "utf-8"));

function serviceName(version: string): string {
  return `node-${version.replace(/\./g, "-")}`;
}

function generateCompose(matrix: Matrix): string {
  const services: Record<string, unknown> = {};

  // Postgres
  services.postgres = {
    image: "postgres:16-alpine",
    environment: {
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: "layr8_test",
    },
    healthcheck: {
      test: ["CMD-SHELL", "pg_isready -U postgres"],
      interval: "2s",
      timeout: "5s",
      retries: 10,
    },
  };

  // Traefik
  services.traefik = {
    image: "traefik:v3.0",
    command: [
      "--providers.docker=true",
      "--providers.docker.exposedbydefault=false",
      "--entrypoints.web.address=:80",
    ],
    ports: ["80:80"],
    volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"],
    depends_on: { postgres: { condition: "service_healthy" } },
  };

  // Cloud-node services
  for (const version of matrix.versions) {
    const name = serviceName(version);
    services[name] = {
      image: `${matrix.image}:${version}`,
      environment: {
        DEPLOYMENT_ENV: "test",
        L8_NODE_DOMAIN_NAME: name,
        L8_NODE_DID_WEB_ALLOW_HTTP: "true",
        L8_NODE_DID_WEB_TARGET_SCHEME: "http",
        L8_NODE_DID_WEB_TARGET_PORT: "9000",
        DATABASE_HOST: "postgres",
        DATABASE_USER: "postgres",
        DATABASE_PASS: "postgres",
        DATABASE_NAME: "layr8_test",
      },
      labels: [
        "traefik.enable=true",
        `traefik.http.routers.${name}.rule=Host(\`${name}.localhost\`)`,
        `traefik.http.routers.${name}.entrypoints=web`,
        `traefik.http.services.${name}.loadbalancer.server.port=4000`,
      ],
      healthcheck: {
        test: ["CMD", "wget", "--spider", "-q", "http://localhost:9000/readyz"],
        interval: "3s",
        timeout: "5s",
        retries: 20,
      },
      depends_on: {
        postgres: { condition: "service_healthy" },
        traefik: { condition: "service_started" },
      },
    };
  }

  const compose = { services };

  // Manual YAML output to avoid dependency on a yaml library
  return toYaml(compose);
}

function toYaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return `${pad}null\n`;
  if (typeof obj === "string") {
    if (obj.includes("`") || obj.includes(":") || obj.includes("{") || obj.includes("#") || obj.startsWith("!")) {
      return `${pad}"${obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\n`;
    }
    return `${pad}${obj}\n`;
  }
  if (typeof obj === "number" || typeof obj === "boolean") return `${pad}${obj}\n`;
  if (Array.isArray(obj)) {
    let out = "";
    for (const item of obj) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        // Object items in array
        const inner = toYamlInline(item);
        out += `${pad}- ${inner}\n`;
      } else {
        const val = typeof item === "string" && (item.includes("`") || item.includes(":") || item.includes("{"))
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
    if (val.includes(":") || val.includes("`") || val.includes("{") || val.includes("#") || val.startsWith("!") || val === "true" || val === "false") {
      return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return val;
  }
  return String(val);
}

function toYamlInline(obj: Record<string, unknown>): string {
  // Simple inline for array-of-strings like healthcheck test
  const parts = Object.entries(obj).map(([k, v]) => `${k}: ${toYamlScalar(v)}`);
  return `{${parts.join(", ")}}`;
}

const output = generateCompose(matrix);
writeFileSync(outputPath, output);
console.log(`Generated ${outputPath}`);
