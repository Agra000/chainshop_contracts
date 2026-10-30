# chainshop-contracts

Smart contract rekber **Mock USDT (mUSDT)** + **invoice on-chain** untuk ChainShop (marketplace B2B).
Berjalan di **Sepolia testnet** — token mUSDT tidak punya nilai, tidak ada uang asli yang terlibat.

| Contract | Fungsi |
| --- | --- |
| `MockUSDT.sol` | ERC-20 6 desimal (`mUSDT`). Faucet publik 10.000 mUSDT per 24 jam per wallet. |
| `ChainShopEscrow.sol` (v3) | Menahan dana tiap order (1 buyer + 1 seller), mencatat invoice, dan mencairkan dana (release / refund). |

## Prinsip: hemat gas, buyer tidak bayar gas setelah deposit

Contract **hanya** menangani aksi yang memindahkan uang + pencatatan invoice. Status lain
(barang sampai, pengajuan refund, keputusan admin, retur, timer 3 hari, batas 3x refund) dikelola
**backend (off-chain)**, jadi buyer, seller, dan admin tidak membayar gas berulang.

**v3:** saat menerima barang buyer cukup **menandatangani** pesan EIP-712 `Acceptance` di MetaMask
(gratis, tanpa Sepolia ETH). Seller lalu menekan **Claim payment** dan mengirim `releaseWithAcceptance`
(gas dibayar seller). Contract memverifikasi tanda tangan buyer, jadi seller tetap tidak bisa mencairkan
dana tanpa persetujuan buyer.

| Alur | Transaksi on-chain |
| --- | --- |
| Normal | buyer `approve` (jika perlu) + `deposit` → seller `markShipped` (invoice) → buyer **tanda tangan** (tanpa gas) → seller `releaseWithAcceptance` |
| Buyer diam 3 hari | … → operator `release` otomatis |
| Refund + retur | `approve` + `deposit` → `markShipped` → **satu** `refund` (seller konfirmasi retur / admin / operator) |
| Seller tolak / tidak kirim | `approve` + `deposit` → `refund` (seller / operator) atau `cancelExpired` (siapa saja setelah batas) |
| Refund ditolak berkali-kali | **tidak ada tx tambahan** |

Contract tetap menjamin: uang **hanya** bisa ke buyer atau seller order tersebut, jumlahnya tetap,
dan hanya **sekali** (tidak bisa dicairkan dua kali).

## Struktur folder

```
contracts/             MockUSDT.sol, ChainShopEscrow.sol
test/                  unit test (22 skenario + pengukuran gas)
scripts/deploy.js      deploy + simpan alamat ke deployments/<network>.json + export ABI
scripts/export-abi.js  export ABI & alamat ke exports/ (untuk FE & BE)
scripts/admin-tools.js grant operator/admin, persingkat batas kirim untuk demo, mint, info
scripts/config.js      parameter default estimasi gas
```

## Persiapan

Butuh Node.js 18+ (disarankan 20/22).

```bash
npm install
cp .env.example .env
```

| Variabel | Keterangan |
| --- | --- |
| `SEPOLIA_RPC_URL` | RPC Sepolia (Alchemy/Infura/publicnode). |
| `DEPLOYER_PRIVATE_KEY` | Private key wallet **khusus testnet** untuk deploy (otomatis jadi admin). Isi Sepolia ETH. Jangan commit `.env`. |
| `ETHERSCAN_API_KEY` | Opsional, untuk verify contract. |
| `ADMIN_WALLET` | Address admin/arbiter (opsional, default = deployer). Deployer tetap ikut jadi admin supaya bisa menjalankan `admin-tools.js`. |
| `OPERATOR_WALLET` | **Address** wallet cron backend (wallet dari `Blockchain:OperatorPrivateKey`). Boleh dikosongkan lalu di-grant belakangan. |
| `MUSDT_ADDRESS` | Opsional, pakai MockUSDT yang sudah ada (saldo mUSDT lama tetap terpakai). |

## Compile & test

```bash
npm run compile
npm test
```

## Deploy ke Sepolia

```bash
npm run deploy:sepolia
```

Output menampilkan alamat contract, isi `.env.local` frontend, dan config backend.
Alamat juga tersimpan di `deployments/sepolia.json`. Deploy cukup **sekali**; menjalankannya lagi
membuat contract baru dengan alamat baru.

Kalau `OPERATOR_WALLET` belum diisi saat deploy:

```bash
ACTION=grant-operator WALLET=0xAlamatOperator npx hardhat run scripts/admin-tools.js --network sepolia
```

Verify (opsional, supaya isi invoice terbaca di Etherscan). Perintah lengkap tercetak setelah deploy:

```bash
npx hardhat verify --network sepolia <MUSDT_ADDRESS>
npx hardhat verify --network sepolia <ESCROW_ADDRESS> <MUSDT_ADDRESS> <ADMIN_WALLET> <OPERATOR_WALLET_atau_0x0000000000000000000000000000000000000000> 135000 5500 2000000000 3000000000
```

## Menghubungkan ke frontend & backend

1. **Frontend** (`chainshop/.env.local`): `NEXT_PUBLIC_CHAIN_ID`, `NEXT_PUBLIC_ESCROW_ADDRESS`, `NEXT_PUBLIC_MUSDT_ADDRESS`.
   Jika contract diubah, jalankan `npm run export-abi` lalu salin `exports/frontend/contracts.js` ke `chainshop/lib/contracts.js`.
2. **Backend** (`chainshop_b`, user-secrets): `Blockchain:EscrowAddress`, `Blockchain:MockUsdtAddress`,
   `Blockchain:OperatorPrivateKey` (wallet yang punya `OPERATOR_ROLE`), opsional `Blockchain:RpcUrl`.
   Timer off-chain diatur di `Blockchain:BuyerConfirmMinutes`, `ReturnShipMinutes`, `ReturnConfirmMinutes`,
   `NotDeliveredMinutes` (default 3 hari / 3 hari / 3 hari / 7 hari).

## Fungsi contract

| Fungsi | Siapa | Efek |
| --- | --- | --- |
| `deposit` | Buyer | Tahan barang + ongkir + estimasi gas. Batas seller kirim = deposit + `sellerShipWindow` (3 hari) |
| `markShipped` | Seller | Validasi invoice (Σ qty × harga = dana barang), emit `InvoiceRecorded`, status `Shipped` |
| `releaseWithAcceptance` | Seller (atau Operator/Admin) | `Shipped` → `Completed` dengan tanda tangan EIP-712 buyer: semua dana ke seller |
| `release` | Buyer, Operator, Admin | `Shipped` → `Completed` tanpa tanda tangan (auto release cron) |
| `refund` | Seller, Operator, Admin | `Funded` → `Cancelled` (semua ke buyer); `Shipped` → `Refunded` (barang + ongkir ke buyer, estimasi gas ke seller) |
| `cancelExpired` | Siapa saja | Darurat: `Funded` & lewat batas kirim → semua ke buyer |
| `claimStale` | Seller | Darurat: `Shipped` & lewat `sellerClaimWindow` (30 hari) tanpa keputusan → dana ke seller |
| `isValidAcceptance`, `acceptanceDigest` | View | Dipakai backend untuk mengecek tanda tangan buyer |
| `setGasParams`, `setWindows`, `pause` | Admin | Parameter. `pause` hanya menghentikan deposit baru |

## Estimasi gas (±)

Buyer membayar estimasi gas untuk **2 transaksi seller** (`markShipped` + `releaseWithAcceptance`), dihitung contract dari jumlah baris barang:

```
gasFee (mUSDT) = (baseGasUnits + perItemGasUnits × itemCount) × gasPriceRefWei × musdtPerEth / 1e18
```

Default: `baseGasUnits = 135.000`, `perItemGasUnits = 5.500`, `gasPriceRefWei = 2 gwei`, kurs fixed `1 ETH = 3.000 mUSDT`
(hasil ukur: markShipped ≈ 50.000 + 4.850/baris, klaim ≈ 63.000, atau ≈ 80.000 untuk wallet seller yang belum pernah menerima mUSDT).
Contoh: 2 baris barang ≈ 0,876 mUSDT. Sebagai gantinya buyer tidak lagi membayar Sepolia ETH untuk menerima barang.
Seluruh estimasi diberikan ke seller (saat selesai maupun refund), dan kembali ke buyer jika order batal sebelum dikirim.

## Pembagian dana

| Hasil | Buyer | Seller |
| --- | --- | --- |
| Selesai (diterima / otomatis) | – | barang + ongkir + estimasi gas |
| Refund setelah dikirim | barang + ongkir | estimasi gas |
| Dibatalkan sebelum dikirim | semua | – |

Tidak ada fee platform (B2B). Gas asli (Sepolia ETH) dibayar masing-masing pengirim transaksi.

## Admin tools

```bash
ACTION=info                           npx hardhat run scripts/admin-tools.js --network sepolia
ACTION=grant-operator WALLET=0x...    npx hardhat run scripts/admin-tools.js --network sepolia
ACTION=grant-admin WALLET=0x...       npx hardhat run scripts/admin-tools.js --network sepolia
ACTION=demo-windows MINUTES=5         npx hardhat run scripts/admin-tools.js --network sepolia   # batas seller kirim 5 menit
ACTION=default-windows                npx hardhat run scripts/admin-tools.js --network sepolia
ACTION=mint WALLET=0x... AMOUNT=50000 npx hardhat run scripts/admin-tools.js --network sepolia
```

(PowerShell: `$env:ACTION="info"; npx hardhat run scripts/admin-tools.js --network sepolia`)

## Keamanan

- OpenZeppelin `SafeERC20`, `ReentrancyGuard`, `AccessControl`, `Pausable`; checks-effects-interactions.
- Operator/admin hanya bisa mencairkan ke buyer/seller order tersebut, tidak ke wallet lain.
- Pintu darurat `cancelExpired` dan `claimStale` mencegah dana tertahan jika backend mati.
- Simpan private key hanya di `.env` / user-secrets, dan hanya pakai wallet testnet.
