// Utilitas admin. Jalankan dengan wallet yang punya ADMIN_ROLE (DEPLOYER_PRIVATE_KEY).
//
//   ACTION=grant-admin WALLET=0x...            npx hardhat run scripts/admin-tools.js --network sepolia
//   ACTION=revoke-admin WALLET=0x...           npx hardhat run scripts/admin-tools.js --network sepolia
//   ACTION=demo-windows MINUTES=5              npx hardhat run scripts/admin-tools.js --network sepolia
//   ACTION=default-windows                     npx hardhat run scripts/admin-tools.js --network sepolia
//   ACTION=mint WALLET=0x... AMOUNT=50000      npx hardhat run scripts/admin-tools.js --network sepolia
//   ACTION=info                                npx hardhat run scripts/admin-tools.js --network sepolia
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  const deployment = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"),
  );
  const escrow = await ethers.getContractAt("ChainShopEscrow", deployment.escrow);
  const token = await ethers.getContractAt("MockUSDT", deployment.mockUsdt);
  const ADMIN_ROLE = await escrow.ADMIN_ROLE();
  const action = process.env.ACTION || "info";
  const DAY = 24 * 60 * 60;

  switch (action) {
    case "grant-admin":
      await (await escrow.grantRole(ADMIN_ROLE, process.env.WALLET)).wait();
      console.log(`ADMIN_ROLE diberikan ke ${process.env.WALLET}`);
      break;
    case "revoke-admin":
      await (await escrow.revokeRole(ADMIN_ROLE, process.env.WALLET)).wait();
      console.log(`ADMIN_ROLE dicabut dari ${process.env.WALLET}`);
      break;
    case "demo-windows": {
      // semua batas waktu dipersingkat untuk demo (default 5 menit, "tak sampai" 2x lipat)
      const m = BigInt(process.env.MINUTES || 5) * 60n;
      await (await escrow.setWindows(m, m, m, m, m * 2n)).wait();
      console.log(`Batas waktu diset ${m / 60n} menit (barang tak sampai: ${(m * 2n) / 60n} menit)`);
      break;
    }
    case "default-windows":
      await (await escrow.setWindows(3 * DAY, 3 * DAY, 3 * DAY, 3 * DAY, 7 * DAY)).wait();
      console.log("Batas waktu dikembalikan ke 3 hari (barang tak sampai: 7 hari)");
      break;
    case "mint": {
      const amount = ethers.parseUnits(process.env.AMOUNT || "10000", 6);
      await (await token.mint(process.env.WALLET, amount)).wait();
      console.log(`Mint ${process.env.AMOUNT || "10000"} mUSDT ke ${process.env.WALLET}`);
      break;
    }
    default: {
      const fmt = (s) => `${Number(s) / 3600} jam`;
      console.log({
        escrow: deployment.escrow,
        mockUsdt: deployment.mockUsdt,
        sellerShipWindow: fmt(await escrow.sellerShipWindow()),
        buyerConfirmWindow: fmt(await escrow.buyerConfirmWindow()),
        returnShipWindow: fmt(await escrow.returnShipWindow()),
        returnConfirmWindow: fmt(await escrow.returnConfirmWindow()),
        notDeliveredWindow: fmt(await escrow.notDeliveredWindow()),
        gasFeeFor1Item: ethers.formatUnits(await escrow.quoteGasFee(1), 6) + " mUSDT",
        gasFeeFor5Items: ethers.formatUnits(await escrow.quoteGasFee(5), 6) + " mUSDT",
        paused: await escrow.paused(),
      });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
