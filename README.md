# chainshop-contracts

Smart contract escrow **Mock USDT (mUSDT)** + **invoice on-chain** untuk ChainShop (marketplace B2B).
Berjalan di **Sepolia testnet** — token mUSDT tidak punya nilai, tidak ada uang asli yang terlibat.

| Contract | Fungsi |
| --- | --- |
| `MockUSDT.sol` | ERC-20 6 desimal (`mUSDT`). Faucet publik 10.000 mUSDT per 24 jam per wallet. |
| `ChainShopEscrow.sol` | Menahan dana tiap order (1 buyer + 1 seller), mencatat invoice, refund + arbiter, batas waktu otomatis. |

## Struktur folder

```
contracts/             MockUSDT.sol, ChainShopEscrow.sol
test/                  unit test (22 skenario + pengukuran gas)
scripts/deploy.js      deploy + simpan alamat ke deployments/<network>.json + export ABI
scripts/export-abi.js  export ABI & alamat ke exports/ (untuk FE & BE)
scripts/admin-tools.js grant admin, persingkat batas waktu untuk demo, mint, info
scripts/config.js      parameter default estimasi gas
```

## Persiapan

Butuh Node.js 18+ (disarankan 20/22).

```bash
npm install
cp .env.example .env
```

Isi `.env`:

| Variabel | Keterangan |
| --- | --- |
| `SEPOLIA_RPC_URL` | RPC Sepolia (Alchemy/Infura/publicnode). |
| `DEPLOYER_PRIVATE_KEY` | Private key wallet **khusus testnet** untuk deploy. Isi Sepolia ETH dari faucet. Jangan commit `.env`. |
| `ETHERSCAN_API_KEY` | API key Etherscan (v2) untuk verify contract. |
| `ADMIN_WALLET` | Wallet admin/arbiter (opsional, default = deployer). Deployer juga tetap mendapat role admin supaya bisa menjalankan `admin-tools.js`; cabut dengan `revoke-admin` jika tidak perlu. |
| `MUSDT_ADDRESS` | Opsional, pakai MockUSDT yang sudah ada (tidak deploy ulang token). |

## Compile & test

```bash
npm run compile
npm test
```

Test mencakup: faucet + cooldown, deposit, seller tolak, autoCancel 3 hari, validasi invoice,
konfirmasi buyer, autoRelease, refund (pause timer, tolak → lanjut sisa waktu, batas 3x),
retur (approve → kirim → konfirmasi), expireReturn, autoRefund, refund barang tak sampai 7 hari,
dan akses admin. Test terakhir mencetak gas `markShipped` + `markDelivered` untuk kalibrasi estimasi.

## Deploy

### Lokal (untuk development)

```bash
npx hardhat node                      # terminal 1
npm run deploy:local                  # terminal 2
```

Tambahkan network "Hardhat" (RPC `http://127.0.0.1:8545`, chain id `31337`) di MetaMask, lalu
import salah satu private key dari output `hardhat node`. Set `NEXT_PUBLIC_CHAIN_ID=31337`.

### Sepolia

```bash
npm run deploy:sepolia
```

Output menampilkan alamat contract, isi `.env.local` frontend, dan config backend. Lalu verify
supaya event invoice bisa dibaca di Etherscan (perintah lengkap tercetak setelah deploy):

```bash
npx hardhat verify --network sepolia <MUSDT_ADDRESS>
npx hardhat verify --network sepolia <ESCROW_ADDRESS> <MUSDT_ADDRESS> <ADMIN_WALLET> 110000 6000 2000000000 3000000000
```

Contract tidak perlu di-hosting: setelah deploy, contract hidup di Sepolia. Repo ini hanya
menyimpan source, test, dan script.

## Menghubungkan ke frontend & backend

1. **Frontend (`chainshop`, branch `api`)** — `.env.local`:
   ```
   NEXT_PUBLIC_CHAIN_ID=11155111
   NEXT_PUBLIC_ESCROW_ADDRESS=0x...
   NEXT_PUBLIC_MUSDT_ADDRESS=0x...
   ```
   Jika contract diubah, jalankan `npm run export-abi` lalu salin
   `exports/frontend/contracts.js` ke `chainshop/lib/contracts.js`.

2. **Backend (`chainshop_b`)** — section `Blockchain` di `appsettings.json` (alamat) dan
   user-secrets untuk private key wallet cron:
   ```bash
   dotnet user-secrets set "Blockchain:EscrowAddress" "0x..."
   dotnet user-secrets set "Blockchain:MockUsdtAddress" "0x..."
   dotnet user-secrets set "Blockchain:RpcUrl" "https://eth-sepolia.g.alchemy.com/v2/<key>"
   dotnet user-secrets set "Blockchain:OperatorPrivateKey" "0x..."   # wallet khusus cron, BUKAN wallet admin
   ```
   - Jalankan `chainshop_b/Database/escrow_onchain_migration.sql` di database.
   - Jadikan wallet admin sebagai admin: `UPDATE msusers SET role = 'admin' WHERE lower(wallet_address) = lower('0x...');`
     lalu login ulang dengan wallet tersebut. Wallet yang sama harus punya `ADMIN_ROLE`
     di contract (otomatis jika dipakai sebagai `ADMIN_WALLET` saat deploy, atau lewat `admin-tools.js`).
   - Wallet operator cron cukup diisi Sepolia ETH dari faucet. Fungsi `auto*` di contract
     bersifat publik dan contract sendiri yang mengecek batas waktu, jadi wallet ini tidak butuh role apa pun.

## Alur & aturan

### Status order di contract

```
Funded ──(seller markShipped + invoice)──► Shipped ──(seller markDelivered)──► Delivered ──(buyer confirmReceived / autoRelease)──► Completed
  │                                           │                                   │
  ├─ sellerCancel / autoCancel ─► Cancelled   └─ requestRefund (≥7 hari, belum     └─ requestRefund (≤3x) ─► RefundRequested
                                                 sampai) ─► RefundRequested              ├─ rejectRefund ─► kembali (timer lanjut sisa waktu)
                                                                                         └─ approveRefund ─► ReturnPending ─► ReturnShipped ─► ReturnDelivered ─► Refunded
                                                                                                              (expireReturn ─► Completed)          (confirmReturnReceived / autoRefund)
```

Refund "barang tak sampai" yang disetujui admin langsung menjadi `Refunded` tanpa retur.

### Batas waktu (bisa diubah admin, default)

| Tahap | Batas | Jika lewat (fungsi publik) |
| --- | --- | --- |
| Deposit → seller ship + invoice | 3 hari | `autoCancel`: semua dana ke buyer |
| Delivered → buyer respon | 3 hari (di-pause saat refund) | `autoRelease`: dana ke seller |
| Refund disetujui → buyer kirim retur | 3 hari | `expireReturn`: refund batal, dana ke seller |
| Retur sampai → seller konfirmasi | 3 hari | `autoRefund`: refund ke buyer |
| Shipped → boleh refund barang tak sampai | 7 hari | – |

Untuk demo: `ACTION=demo-windows MINUTES=5 npx hardhat run scripts/admin-tools.js --network sepolia`
(kembalikan dengan `ACTION=default-windows`).

### Pembagian dana

| Hasil | Buyer | Seller |
| --- | --- | --- |
| Selesai (diterima / auto) | – | barang + ongkir + estimasi gas |
| Refund (retur / barang tak sampai) | barang + ongkir | estimasi gas |
| Dibatalkan (seller tolak / tidak ship 3 hari) | semua | – |

Tidak ada fee platform (B2B).

### Estimasi gas (±)

Buyer membayar estimasi gas untuk 2 transaksi seller (`markShipped` dan `markDelivered`), dihitung
contract dari jumlah baris barang:

```
gasFee (mUSDT) = (baseGasUnits + perItemGasUnits × itemCount) × gasPriceRefWei × musdtPerEth / 1e18
```

Default: `baseGasUnits = 110.000`, `perItemGasUnits = 6.000`, `gasPriceRefWei = 2 gwei`,
kurs fixed `1 ETH = 3.000 mUSDT` (hasil ukur test ≈ 94.000 + 4.900/baris, ditambah buffer).
Seluruh estimasi diberikan ke seller (termasuk sisanya). `deposit` menerima `maxGasFee` supaya
buyer terlindungi jika admin mengubah parameter setelah harga ditampilkan. Admin bisa mengubah
parameter lewat `setGasParams`.

### Invoice on-chain

Saat seller memanggil `markShipped`, contract memvalidasi jumlah `qty × unitPrice` = dana barang
di escrow, lalu memancarkan event `InvoiceRecorded` berisi: invoice id, wallet seller & buyer,
daftar barang (nama, qty, harga), total barang, ongkir, estimasi gas, total dibayar, kurir,
nomor resi, waktu beli, dan waktu kirim. Tx hash transaksi ini adalah **ID transaksi invoice**
yang dipakai buyer saat mengajukan refund, dan bisa dibuka di `https://sepolia.etherscan.io/tx/<hash>`
(tab Logs, ter-decode karena contract di-verify).

## Admin tools

```bash
ACTION=info                         npx hardhat run scripts/admin-tools.js --network sepolia
ACTION=grant-admin WALLET=0x...     npx hardhat run scripts/admin-tools.js --network sepolia
ACTION=revoke-admin WALLET=0x...    npx hardhat run scripts/admin-tools.js --network sepolia
ACTION=mint WALLET=0x... AMOUNT=50000 npx hardhat run scripts/admin-tools.js --network sepolia
```

## Keamanan

- OpenZeppelin `SafeERC20`, `ReentrancyGuard`, `AccessControl`, `Pausable` (pause hanya
  menghentikan deposit baru; order berjalan tetap bisa diselesaikan).
- Pola checks-effects-interactions: status diubah sebelum transfer token.
- `orderId` unik, seller ≠ buyer, maksimal 50 baris barang per invoice.
- Semua batas waktu dicek di contract, sehingga backend/cron tidak bisa mencairkan dana lebih awal.
- Simpan private key hanya di `.env` / user-secrets, dan hanya pakai wallet testnet.
