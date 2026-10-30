const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const DAY = 24 * 60 * 60;
const U = (n) => ethers.parseUnits(String(n), 6); // mUSDT 6 desimal
const oid = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

const Status = { None: 0, Funded: 1, Shipped: 2, Completed: 3, Refunded: 4, Cancelled: 5 };

// default gas params (lihat scripts/config.js)
const GAS = { base: 135_000n, perItem: 5_500n, priceWei: 2_000_000_000n, musdtPerEth: 3_000n * 10n ** 6n };

const ITEMS = [
  { name: "Semen Gresik 50kg", qty: 100n, unitPrice: U(65) },
  { name: "Besi Beton 12mm", qty: 50n, unitPrice: U(95) },
];
const ITEMS_TOTAL = U(65 * 100 + 95 * 50); // 11.250
const SHIPPING = U(1);
const START = U(100_000); // saldo awal buyer

async function deployFixture() {
  const [admin, buyer, seller, operator, other] = await ethers.getSigners();
  const token = await ethers.deployContract("MockUSDT");
  const escrow = await ethers.deployContract("ChainShopEscrow", [
    await token.getAddress(),
    admin.address,
    operator.address,
    GAS.base,
    GAS.perItem,
    GAS.priceWei,
    GAS.musdtPerEth,
  ]);

  await token.connect(buyer).faucet();
  await token.connect(admin).mint(buyer.address, START - U(10_000));
  await token.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256);

  return { admin, buyer, seller, operator, other, token, escrow };
}

async function fundedFixture() {
  const ctx = await loadFixture(deployFixture);
  const orderId = oid("order-1");
  const gasFee = await ctx.escrow.quoteGasFee(ITEMS.length);
  await ctx.escrow
    .connect(ctx.buyer)
    .deposit(orderId, ctx.seller.address, ITEMS_TOTAL, SHIPPING, ITEMS.length, gasFee);
  return { ...ctx, orderId, gasFee, total: ITEMS_TOTAL + SHIPPING + gasFee };
}

function ship(ctx) {
  return ctx.escrow.connect(ctx.seller).markShipped(ctx.orderId, "INV-2026-0001", ITEMS, "JNE", "JNE2610280001");
}

async function shippedFixture() {
  const ctx = await fundedFixture();
  await ship(ctx);
  return ctx;
}


// tanda tangan EIP-712 buyer (gratis, tanpa gas) untuk releaseWithAcceptance
async function signAcceptance(escrow, signer, orderId, override = {}) {
  const o = await escrow.getOrder(orderId);
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: "ChainShopEscrow", version: "1", chainId, verifyingContract: await escrow.getAddress() };
  const types = {
    Acceptance: [
      { name: "orderId", type: "bytes32" },
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  };
  const message = {
    orderId,
    buyer: o.buyer,
    seller: o.seller,
    amount: o.itemsTotal + o.shippingFee + o.gasFee,
    ...override,
  };
  return signer.signTypedData(override.domain ?? domain, types, message);
}

describe("MockUSDT", function () {
  it("faucet memberi 10.000 mUSDT dan dibatasi 1x per 24 jam", async function () {
    const { token, other } = await loadFixture(deployFixture);
    expect(await token.decimals()).to.equal(6);
    await token.connect(other).faucet();
    expect(await token.balanceOf(other.address)).to.equal(U(10_000));
    await expect(token.connect(other).faucet()).to.be.revertedWithCustomError(token, "FaucetCooldown");
    await time.increase(DAY);
    await token.connect(other).faucet();
    expect(await token.balanceOf(other.address)).to.equal(U(20_000));
  });

  it("mint hanya owner", async function () {
    const { token, other } = await loadFixture(deployFixture);
    await expect(token.connect(other).mint(other.address, 1)).to.be.revertedWithCustomError(
      token,
      "OwnableUnauthorizedAccount",
    );
  });
});

describe("ChainShopEscrow", function () {
  describe("deposit", function () {
    it("menahan harga barang + ongkir + estimasi gas 1 transaksi seller", async function () {
      const { escrow, token, buyer, seller, orderId, gasFee, total } = await fundedFixture();
      const expectedGas = ((GAS.base + GAS.perItem * 2n) * GAS.priceWei * GAS.musdtPerEth) / 10n ** 18n;
      expect(gasFee).to.equal(expectedGas);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(total);

      const o = await escrow.getOrder(orderId);
      expect(o.buyer).to.equal(buyer.address);
      expect(o.seller).to.equal(seller.address);
      expect(o.status).to.equal(Status.Funded);
      expect(o.shipDeadline).to.equal(o.fundedAt + BigInt(3 * DAY));
    });

    it("menolak orderId ganda, seller = buyer, dan gas melebihi batas buyer", async function () {
      const { escrow, buyer, seller, orderId, gasFee } = await fundedFixture();
      await expect(
        escrow.connect(buyer).deposit(orderId, seller.address, ITEMS_TOTAL, SHIPPING, 2, gasFee),
      ).to.be.revertedWithCustomError(escrow, "OrderExists");
      await expect(
        escrow.connect(buyer).deposit(oid("x"), buyer.address, ITEMS_TOTAL, SHIPPING, 2, gasFee),
      ).to.be.revertedWithCustomError(escrow, "InvalidInput");
      await expect(
        escrow.connect(buyer).deposit(oid("y"), seller.address, ITEMS_TOTAL, SHIPPING, 2, gasFee - 1n),
      ).to.be.revertedWithCustomError(escrow, "GasFeeTooHigh");
    });

    it("pause menghentikan deposit baru", async function () {
      const { escrow, admin, buyer, seller } = await loadFixture(deployFixture);
      await escrow.connect(admin).pause();
      await expect(
        escrow.connect(buyer).deposit(oid("p"), seller.address, ITEMS_TOTAL, 0, 2, U(100)),
      ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    });
  });

  describe("sebelum dikirim", function () {
    it("seller tolak (refund saat Funded) -> semua dana ke buyer", async function () {
      const { escrow, token, buyer, seller, orderId, total } = await fundedFixture();
      await expect(escrow.connect(seller).refund(orderId))
        .to.emit(escrow, "OrderCancelled")
        .withArgs(orderId, total, seller.address);
      expect(await token.balanceOf(buyer.address)).to.equal(START);
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.Cancelled);
    });

    it("operator auto cancel saat seller telat kirim", async function () {
      const { escrow, token, buyer, operator, orderId } = await fundedFixture();
      await time.increase(3 * DAY + 1);
      await expect(escrow.connect(operator).refund(orderId)).to.emit(escrow, "OrderCancelled");
      expect(await token.balanceOf(buyer.address)).to.equal(START);
    });

    it("pintu darurat cancelExpired: siapa saja, hanya setelah batas kirim", async function () {
      const { escrow, token, buyer, other, orderId } = await fundedFixture();
      await expect(escrow.connect(other).cancelExpired(orderId)).to.be.revertedWithCustomError(
        escrow,
        "DeadlineNotPassed",
      );
      await time.increase(3 * DAY + 1);
      await escrow.connect(other).cancelExpired(orderId);
      expect(await token.balanceOf(buyer.address)).to.equal(START);
    });

    it("seller tidak bisa ship setelah batas waktu", async function () {
      const ctx = await fundedFixture();
      await time.increase(3 * DAY + 1);
      await expect(ship(ctx)).to.be.revertedWithCustomError(ctx.escrow, "DeadlinePassed");
    });

    it("buyer tidak bisa release sebelum barang dikirim", async function () {
      const { escrow, buyer, orderId } = await fundedFixture();
      await expect(escrow.connect(buyer).release(orderId)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });
  });

  describe("ship + invoice", function () {
    it("mencatat invoice onchain lengkap dengan item dan rincian biaya", async function () {
      const ctx = await fundedFixture();
      const { escrow, seller, buyer, orderId, gasFee, total } = ctx;
      await expect(ship(ctx))
        .to.emit(escrow, "InvoiceRecorded")
        .withArgs(
          orderId,
          "INV-2026-0001",
          seller.address,
          buyer.address,
          anyValue,
          ITEMS_TOTAL,
          SHIPPING,
          gasFee,
          total,
          "JNE",
          "JNE2610280001",
          anyValue,
          anyValue,
        );
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.Shipped);
    });

    it("menolak invoice yang tidak cocok dengan dana escrow", async function () {
      const { escrow, seller, orderId } = await fundedFixture();
      const wrongPrice = [ITEMS[0], { ...ITEMS[1], unitPrice: U(94) }];
      await expect(
        escrow.connect(seller).markShipped(orderId, "INV", wrongPrice, "JNE", "R1"),
      ).to.be.revertedWithCustomError(escrow, "InvoiceMismatch");
      await expect(
        escrow.connect(seller).markShipped(orderId, "INV", [ITEMS[0]], "JNE", "R1"),
      ).to.be.revertedWithCustomError(escrow, "InvoiceMismatch");
    });

    it("hanya seller order yang boleh ship", async function () {
      const { escrow, other, orderId } = await fundedFixture();
      await expect(
        escrow.connect(other).markShipped(orderId, "INV", ITEMS, "JNE", "R1"),
      ).to.be.revertedWithCustomError(escrow, "NotSeller");
    });
  });

  describe("release", function () {
    it("buyer terima barang -> semua dana ke seller", async function () {
      const { escrow, token, buyer, seller, orderId, total } = await shippedFixture();
      await expect(escrow.connect(buyer).release(orderId))
        .to.emit(escrow, "Released")
        .withArgs(orderId, total, buyer.address);
      expect(await token.balanceOf(seller.address)).to.equal(total);
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.Completed);
    });

    it("operator & admin boleh release (timer off-chain), pihak lain tidak", async function () {
      const { escrow, operator, other, seller, orderId } = await shippedFixture();
      await expect(escrow.connect(other).release(orderId)).to.be.revertedWithCustomError(escrow, "NotAllowed");
      await expect(escrow.connect(seller).release(orderId)).to.be.revertedWithCustomError(escrow, "NotAllowed");
      await expect(escrow.connect(operator).release(orderId)).to.emit(escrow, "Released");
    });

    it("tidak bisa dicairkan dua kali", async function () {
      const { escrow, buyer, operator, orderId } = await shippedFixture();
      await escrow.connect(buyer).release(orderId);
      await expect(escrow.connect(operator).release(orderId)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
      await expect(escrow.connect(operator).refund(orderId)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("pintu darurat claimStale: seller klaim setelah 30 hari tanpa keputusan", async function () {
      const { escrow, token, seller, orderId, total } = await shippedFixture();
      await expect(escrow.connect(seller).claimStale(orderId)).to.be.revertedWithCustomError(
        escrow,
        "DeadlineNotPassed",
      );
      await time.increase(30 * DAY + 1);
      await escrow.connect(seller).claimStale(orderId);
      expect(await token.balanceOf(seller.address)).to.equal(total);
    });
  });

  describe("releaseWithAcceptance (buyer tanda tangan, seller klaim)", function () {
    it("seller klaim dana dengan tanda tangan buyer -> semua dana ke seller, gas dibayar seller", async function () {
      const ctx = await loadFixture(shippedFixture);
      const { escrow, token, buyer, seller, orderId, total } = ctx;
      const sig = await signAcceptance(escrow, buyer, orderId);
      expect(await escrow.isValidAcceptance(orderId, sig)).to.equal(true);
      const buyerEthBefore = await ethers.provider.getBalance(buyer.address);

      await expect(escrow.connect(seller).releaseWithAcceptance(orderId, sig))
        .to.emit(escrow, "Released")
        .withArgs(orderId, total, seller.address);
      expect(await token.balanceOf(seller.address)).to.equal(total);
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.Completed);
      // buyer tidak mengeluarkan ETH sama sekali untuk menerima barang
      expect(await ethers.provider.getBalance(buyer.address)).to.equal(buyerEthBefore);
    });

    it("menolak tanda tangan selain buyer, order lain, jumlah lain, atau contract lain", async function () {
      const ctx = await loadFixture(shippedFixture);
      const { escrow, buyer, seller, other, orderId } = ctx;
      const bad = [
        await signAcceptance(escrow, other, orderId),
        await signAcceptance(escrow, seller, orderId),
        await signAcceptance(escrow, buyer, orderId, { orderId: oid("order-lain") }),
        await signAcceptance(escrow, buyer, orderId, { amount: 1n }),
        await signAcceptance(escrow, buyer, orderId, {
          domain: { name: "ChainShopEscrow", version: "1", chainId: 1n, verifyingContract: await escrow.getAddress() },
        }),
      ];
      for (const sig of bad) {
        expect(await escrow.isValidAcceptance(orderId, sig)).to.equal(false);
        await expect(escrow.connect(seller).releaseWithAcceptance(orderId, sig)).to.be.revertedWithCustomError(
          escrow,
          "InvalidSignature",
        );
      }
    });

    it("hanya seller / operator / admin yang boleh mengirim, dan hanya saat Shipped", async function () {
      const ctx = await loadFixture(fundedFixture);
      const { escrow, buyer, seller, operator, other, orderId } = ctx;
      const early = await signAcceptance(escrow, buyer, orderId);
      await expect(escrow.connect(seller).releaseWithAcceptance(orderId, early))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.Funded);

      await ship(ctx);
      const sig = await signAcceptance(escrow, buyer, orderId);
      await expect(escrow.connect(other).releaseWithAcceptance(orderId, sig)).to.be.revertedWithCustomError(
        escrow,
        "NotAllowed",
      );
      await escrow.connect(operator).releaseWithAcceptance(orderId, sig);
      // tidak bisa dipakai ulang (dana sudah cair)
      await expect(escrow.connect(seller).releaseWithAcceptance(orderId, sig))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.Completed);
    });
  });

  describe("refund setelah dikirim", function () {
    it("seller konfirmasi retur -> barang+ongkir ke buyer, estimasi gas ke seller", async function () {
      const { escrow, token, buyer, seller, orderId, gasFee } = await shippedFixture();
      await expect(escrow.connect(seller).refund(orderId))
        .to.emit(escrow, "Refunded")
        .withArgs(orderId, ITEMS_TOTAL + SHIPPING, gasFee, seller.address);
      expect(await token.balanceOf(buyer.address)).to.equal(START - gasFee);
      expect(await token.balanceOf(seller.address)).to.equal(gasFee);
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.Refunded);
    });

    it("admin approve refund barang tak sampai & operator auto refund", async function () {
      const a = await shippedFixture();
      await expect(a.escrow.connect(a.admin).refund(a.orderId)).to.emit(a.escrow, "Refunded");

      const b = await loadFixture(deployFixture);
      const id = oid("order-2");
      const gas = await b.escrow.quoteGasFee(2);
      await b.escrow.connect(b.buyer).deposit(id, b.seller.address, ITEMS_TOTAL, SHIPPING, 2, gas);
      await b.escrow.connect(b.seller).markShipped(id, "INV-2", ITEMS, "JNE", "R2");
      await expect(b.escrow.connect(b.operator).refund(id)).to.emit(b.escrow, "Refunded");
    });

    it("buyer & pihak lain tidak bisa refund sendiri", async function () {
      const { escrow, buyer, other, orderId } = await shippedFixture();
      await expect(escrow.connect(buyer).refund(orderId)).to.be.revertedWithCustomError(escrow, "NotAllowed");
      await expect(escrow.connect(other).refund(orderId)).to.be.revertedWithCustomError(escrow, "NotAllowed");
    });
  });

  describe("admin", function () {
    it("parameter & role hanya bisa diubah admin", async function () {
      const { escrow, admin, other } = await loadFixture(deployFixture);
      await expect(escrow.connect(other).setWindows(60, 60)).to.be.revertedWithCustomError(
        escrow,
        "AccessControlUnauthorizedAccount",
      );
      await escrow.connect(admin).setWindows(300, 600);
      expect(await escrow.sellerShipWindow()).to.equal(300);
      expect(await escrow.isOperatorOrAdmin(admin.address)).to.equal(true);
      expect(await escrow.isOperatorOrAdmin(other.address)).to.equal(false);
    });
  });

  describe("gas usage (untuk kalibrasi estimasi)", function () {
    it("mencetak gas markShipped + klaim seller per jumlah item", async function () {
      const { escrow, buyer, seller } = await loadFixture(deployFixture);
      for (const n of [1, 2, 5, 10]) {
        const items = Array.from({ length: n }, (_, i) => ({
          name: `Produk contoh dengan nama cukup panjang nomor ${i + 1}`,
          qty: 3n,
          unitPrice: U(12.5),
        }));
        const total = items.reduce((s, it) => s + it.qty * it.unitPrice, 0n);
        const id = oid(`gas-${n}`);
        await escrow.connect(buyer).deposit(id, seller.address, total, SHIPPING, n, U(1000));
        const shipTx = await escrow
          .connect(seller)
          .markShipped(id, "INV-2026-ABCDEF", items, "J&T Express", "JT2610281234567");
        const shipGas = (await shipTx.wait()).gasUsed;
        const sig = await signAcceptance(escrow, buyer, id);
        const claimTx = await escrow.connect(seller).releaseWithAcceptance(id, sig);
        const claimGas = (await claimTx.wait()).gasUsed;
        const estimateUnits = GAS.base + GAS.perItem * BigInt(n);
        console.log(`      items=${n} markShipped=${shipGas} claim=${claimGas} total=${shipGas + claimGas} estimate=${estimateUnits}`);
        expect(estimateUnits).to.be.gte(shipGas + claimGas);
      }
    });
  });
});
