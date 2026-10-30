// Nilai default parameter estimasi gas.
// v3: estimasi menanggung 2 transaksi seller: markShipped (invoice) + releaseWithAcceptance (klaim dana).
// Diukur dari test (npx hardhat test):
//   markShipped ≈ 50.000 gas + ±4.850 gas per baris barang
//   klaim dana  ≈ 63.000 gas (≈ 80.000 jika wallet seller belum pernah menerima mUSDT)
// lalu diberi buffer kecil.
module.exports = {
  GAS_DEFAULTS: {
    baseGasUnits: 135_000n,
    perItemGasUnits: 5_500n,
    gasPriceRefWei: 2_000_000_000n, // 2 gwei
    musdtPerEth: 3_000n * 10n ** 6n, // kurs fixed: 1 ETH = 3.000 mUSDT
  },
};
