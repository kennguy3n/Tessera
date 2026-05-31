/**
 * Release-time signing tool for Tessera auto-update artifacts.
 *
 * Usage (run from `apps/desktop/`):
 *
 *   tsx scripts/signUpdateArtifact.ts \
 *     --key path/to/private.pem \
 *     path/to/Tessera-Setup-1.2.3.exe
 *
 * Outputs `<artifact>.sig` next to the input. Pair this with
 * `verifyUpdateSignature` in `electron/updaterSignature.ts`.
 *
 * # Key generation
 *
 * Generate an Ed25519 keypair off-line on the release manager's
 * hardware:
 *
 *   openssl genpkey -algorithm ed25519 -out updater-priv.pem
 *   openssl pkey -in updater-priv.pem -pubout -outform DER \
 *     | tail -c 32 | base64
 *
 * The base64 line is the public key — add it to
 * `UPDATER_TRUST_ANCHORS` in `electron/updaterSignature.ts`. Keep the
 * `.pem` private key off-line and back it up to an air-gapped store.
 *
 * # Release workflow
 *
 * 1. Build the installer (`electron-builder`, etc.) and find the
 *    artifact path (e.g. `dist/Tessera-Setup-1.2.3.exe`).
 * 2. Run this tool with `--key` pointing at the private-key `.pem`.
 *    The signature is written to `<artifact>.sig`.
 * 3. Upload BOTH the artifact AND the `.sig` to the release
 *    publish endpoint (`electron-builder.yml`'s `publish` block must
 *    include the `.sig` in the artifact list).
 * 4. Clients with `enforceUpdateSignature: true` download both files;
 *    `verifyUpdateSignature` reads the `.sig` and gates install on
 *    successful verification.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

interface CliArgs {
  artifactPath: string;
  privateKeyPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  let privateKeyPath: string | undefined;
  let artifactPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--key" || arg === "-k") {
      privateKeyPath = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      artifactPath = arg;
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  if (!privateKeyPath) {
    console.error("Missing required argument: --key <private-key.pem>");
    printUsage();
    process.exit(1);
  }
  if (!artifactPath) {
    console.error("Missing required argument: <artifact-path>");
    printUsage();
    process.exit(1);
  }

  return { artifactPath, privateKeyPath };
}

function printUsage(): void {
  console.log(
    [
      "Usage: tsx scripts/signUpdateArtifact.ts --key <private.pem> <artifact>",
      "",
      "Generates an Ed25519 detached signature for the artifact and writes",
      "it to <artifact>.sig next to the input. Pair with",
      "electron/updaterSignature.ts at runtime.",
    ].join("\n"),
  );
}

function signArtifact(args: CliArgs): void {
  const artifact = path.resolve(args.artifactPath);
  const keyPath = path.resolve(args.privateKeyPath);

  if (!fs.existsSync(artifact)) {
    throw new Error(`Artifact not found: ${artifact}`);
  }
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Private key not found: ${keyPath}`);
  }

  const privateKey = crypto.createPrivateKey({
    key: fs.readFileSync(keyPath),
    format: "pem",
  });

  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `Expected an Ed25519 private key, got ${privateKey.asymmetricKeyType}`,
    );
  }

  const artifactBytes = fs.readFileSync(artifact);
  const signature = crypto.sign(null, artifactBytes, privateKey);
  const sigPath = `${artifact}.sig`;
  fs.writeFileSync(sigPath, signature);

  console.log(
    `Signed ${path.basename(artifact)} (${artifactBytes.length} bytes) → ${path.basename(sigPath)} (${signature.length} bytes)`,
  );
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    signArtifact(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`signUpdateArtifact: ${message}`);
    process.exit(1);
  }
}

main();
