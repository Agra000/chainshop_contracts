// Export ABI + alamat contract ke folder exports/ supaya tinggal di-copy ke FE & BE.
//
//   npx hardhat run scripts/export-abi.js --network sepolia
//
// Hasil:
//   exports/frontend/contracts.js        -> copy ke chainshop/lib/contracts.js
//   exports/backend/ChainShopEscrow.abi.json (referensi, BE memakai class Nethereum yang sudah ditulis manual)
//   exports/addresses.<network>.json
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function exportArtifacts(networkName = hre.network.name) {
  const root = path.join(__dirname, "..");
  const deploymentFile = path.join(root, "deployments", `${networkName}.json`);
  const deployment = fs.existsSync(deploymentFile) ? JSON.parse(fs.readFileSync(deploymentFile, "utf8")) : {};

  const escrow = await hre.artifacts.readArtifact("ChainShopEscrow");
  const token = await hre.artifacts.readArtifact("MockUSDT");

  const out = path.join(root, "exports");
  fs.mkdirSync(path.join(out, "frontend"), { recursive: true });
  fs.mkdirSync(path.join(out, "backend"), { recursive: true });

  fs.writeFileSync(
    path.join(out, "frontend", "contracts.js"),
    `// AUTO-GENERATED oleh chainshop-contracts/scripts/export-abi.js — jangan diedit manual.\n` +
      `export const ESCROW_ABI = ${JSON.stringify(escrow.abi, null, 2)};\n\n` +
      `export const MUSDT_ABI = ${JSON.stringify(token.abi, null, 2)};\n`,
  );
  fs.writeFileSync(path.join(out, "backend", "ChainShopEscrow.abi.json"), JSON.stringify(escrow.abi, null, 2));
  fs.writeFileSync(path.join(out, "backend", "MockUSDT.abi.json"), JSON.stringify(token.abi, null, 2));
  fs.writeFileSync(
    path.join(out, `addresses.${networkName}.json`),
    JSON.stringify(
      {
        chainId: deployment.chainId,
        escrow: deployment.escrow,
        mockUsdt: deployment.mockUsdt,
        escrowDeployBlock: deployment.escrowDeployBlock,
      },
      null,
      2,
    ),
  );

  console.log("ABI ter-export ke folder exports/");
  if (deployment.escrow) {
    console.log("\nENV frontend (.env.local):");
    console.log(`  NEXT_PUBLIC_CHAIN_ID=${deployment.chainId}`);
    console.log(`  NEXT_PUBLIC_ESCROW_ADDRESS=${deployment.escrow}`);
    console.log(`  NEXT_PUBLIC_MUSDT_ADDRESS=${deployment.mockUsdt}`);
    console.log("\nBackend (user-secrets / env):");
    console.log(`  Blockchain:EscrowAddress=${deployment.escrow}`);
    console.log(`  Blockchain:MockUsdtAddress=${deployment.mockUsdt}`);
  }
}

module.exports = { exportArtifacts };

if (require.main === module) {
  exportArtifacts().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
