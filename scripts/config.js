// Nilai default parameter estimasi gas.
// Diukur dari test (npx hardhat test): markShipped + markDelivered ≈ 94.000 + 4.900 gas per baris barang,
// lalu diberi buffer ±15%.
module.exports = {
  GAS_DEFAULTS: {
    baseGasUnits: 110_000n,
    perItemGasUnits: 6_000n,
    gasPriceRefWei: 2_000_000_000n, // 2 gwei
    musdtPerEth: 3_000n * 10n ** 6n, // kurs fixed: 1 ETH = 3.000 mUSDT
  },
};
