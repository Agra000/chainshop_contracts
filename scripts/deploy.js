// Deploy MockUSDT + ChainShopEscrow, simpan alamat ke deployments/<network>.json,
// lalu export ABI + alamat untuk frontend & backend (folder exports/).
//
//   npx hardhat run scripts/deploy.js --network sepolia
//
// ENV opsional:
//   ADMIN_WALLET     wallet admin/arbiter (default: wallet deployer)
//   OPERATOR_WALLET  wallet backend/cron (auto release & refund). Address, bukan private key.
//   MUSDT_ADDRESS  pakai MockUSDT yang sudah ada (tidak deploy ulang token)
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { GAS_DEFAULTS } = require("./config");
const { exportArtifacts } = require("./export-abi");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY belum diisi di .env");

  // alamat di .env harus 0x + 40 karakter hex; selain itu ethers mengira itu nama ENS dan error "resolveName"
  function envAddress(name) {
    const raw = (process.env[name] || "").trim().replace(/^["']|["']$/g, "");
    if (!raw) return "";
    if (!ethers.isAddress(raw)) {
      const hint = /^(0x)?[0-9a-fA-F]{64}$/.test(raw) ? " (sepertinya ini PRIVATE KEY, isi dengan ADDRESS wallet)" : "";
      throw new Error(`${name} di .env bukan address yang valid: "${raw}"${hint}. Format: 0x diikuti 40 karakter hex, atau kosongkan.`);
    }
    return ethers.getAddress(raw.toLowerCase());
  }

  const admin = envAddress("ADMIN_WALLET") || deployer.address;
  const operator = envAddress("OPERATOR_WALLET") || ethers.ZeroAddress;
  console.log(`Network  : ${network.name} (chainId ${network.config.chainId ?? "local"})`);
  console.log(`Deployer : ${deployer.address}`);
  console.log(`Admin    : ${admin}`);
  console.log(`Operator : ${operator === ethers.ZeroAddress ? "(belum diisi, grant nanti lewat admin-tools)" : operator}`);

  let tokenAddress = envAddress("MUSDT_ADDRESS");
  if (tokenAddress) {
    console.log(`MockUSDT : pakai yang sudah ada ${tokenAddress}`);
  } else {
    const token = await ethers.deployContract("MockUSDT");
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    console.log(`MockUSDT : ${tokenAddress}`);
  }

  const escrow = await ethers.deployContract("ChainShopEscrow", [
    tokenAddress,
    admin,
    operator,
    GAS_DEFAULTS.baseGasUnits,
    GAS_DEFAULTS.perItemGasUnits,
    GAS_DEFAULTS.gasPriceRefWei,
    GAS_DEFAULTS.musdtPerEth,
  ]);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  const deployBlock = (await escrow.deploymentTransaction().wait()).blockNumber;
  console.log(`Escrow   : ${escrowAddress} (block ${deployBlock})`);

  const deployment = {
    network: network.name,
    chainId: Number(network.config.chainId ?? 31337),
    mockUsdt: tokenAddress,
    escrow: escrowAddress,
    escrowDeployBlock: deployBlock,
    admin,
    operator,
    deployer: deployer.address,
    gasParams: Object.fromEntries(Object.entries(GAS_DEFAULTS).map(([k, v]) => [k, v.toString()])),
    deployedAt: new Date().toISOString(),
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(deployment, null, 2));
  console.log(`\nTersimpan di deployments/${network.name}.json`);

  await exportArtifacts(network.name);

  if (network.name === "sepolia") {
    console.log("\nVerifikasi di Etherscan (setelah ~1 menit):");
    if (!envAddress("MUSDT_ADDRESS")) console.log(`  npx hardhat verify --network sepolia ${tokenAddress}`);
    console.log(
      `  npx hardhat verify --network sepolia ${escrowAddress} ${tokenAddress} ${admin} ${operator} ` +
        `${GAS_DEFAULTS.baseGasUnits} ${GAS_DEFAULTS.perItemGasUnits} ${GAS_DEFAULTS.gasPriceRefWei} ${GAS_DEFAULTS.musdtPerEth}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
