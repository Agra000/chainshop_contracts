const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const DAY = 24 * 60 * 60;
const U = (n) => ethers.parseUnits(String(n), 6); // mUSDT 6 desimal
const oid = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

const Status = {
  None: 0,
  Funded: 1,
  Shipped: 2,
  Delivered: 3,
  RefundRequested: 4,
  ReturnPending: 5,
  ReturnShipped: 6,
  ReturnDelivered: 7,
  Completed: 8,
  Refunded: 9,
  Cancelled: 10,
};

// default gas params (lihat scripts/deploy.js)
const GAS = { base: 110_000n, perItem: 6_000n, priceWei: 2_000_000_000n, musdtPerEth: 3_000n * 10n ** 6n };

const ITEMS = [
  { name: "Semen Gresik 50kg", qty: 100n, unitPrice: U(65) },
  { name: "Besi Beton 12mm", qty: 50n, unitPrice: U(95) },
];
const ITEMS_TOTAL = U(65 * 100 + 95 * 50); // 11.250
const SHIPPING = U(1);
const START = U(100_000); // saldo awal buyer

async function deployFixture() {
  const [admin, buyer, seller, other] = await ethers.getSigners();
  const token = await ethers.deployContract("MockUSDT");
  const escrow = await ethers.deployContract("ChainShopEscrow", [
    await token.getAddress(),
    admin.address,
    GAS.base,
    GAS.perItem,
    GAS.priceWei,
    GAS.musdtPerEth,
  ]);

  await token.connect(buyer).faucet();
  await token.connect(admin).mint(buyer.address, START - U(10_000));
  await token.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256);

  return { admin, buyer, seller, other, token, escrow };
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

async function ship(ctx) {
  return ctx.escrow.connect(ctx.seller).markShipped(ctx.orderId, "INV-2026-0001", ITEMS, "JNE", "JNE2610280001");
}

async function deliveredFixture() {
  const ctx = await fundedFixture();
  await ship(ctx);
  await ctx.escrow.connect(ctx.seller).markDelivered(ctx.orderId);
  return ctx;
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
    it("menahan harga barang + ongkir + estimasi gas", async function () {
      const { escrow, token, buyer, seller, orderId, gasFee, total } = await fundedFixture();

      const expectedGas = ((GAS.base + GAS.perItem * 2n) * GAS.priceWei * GAS.musdtPerEth) / 10n ** 18n;
      expect(gasFee).to.equal(expectedGas);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(total);

      const o = await escrow.getOrder(orderId);
      expect(o.buyer).to.equal(buyer.address);
      expect(o.seller).to.equal(seller.address);
      expect(o.status).to.equal(Status.Funded);
      expect(o.deadline).to.equal(o.fundedAt + BigInt(3 * DAY));
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

  describe("seller tolak / timeout", function () {
    it("sellerCancel mengembalikan semua dana ke buyer", async function () {
      const { escrow, token, buyer, seller, orderId } = await fundedFixture();
      await expect(escrow.connect(seller).sellerCancel(orderId))
        .to.emit(escrow, "OrderCancelled")
        .withArgs(orderId, 0, anyValue);
      expect(await token.balanceOf(buyer.address)).to.equal(START);
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.Cancelled);
    });

    it("autoCancel hanya setelah 3 hari, boleh dipanggil siapa saja", async function () {
      const { escrow, token, buyer, other, orderId } = await fundedFixture();
      await expect(escrow.connect(other).autoCancel(orderId)).to.be.revertedWithCustomError(
        escrow,
        "DeadlineNotPassed",
      );
      expect(await escrow.pendingAutoAction(orderId)).to.equal(0);

      await time.increase(3 * DAY + 1);
      expect(await escrow.pendingAutoAction(orderId)).to.equal(1);
      await escrow.connect(other).autoCancel(orderId);
      expect(await token.balanceOf(buyer.address)).to.equal(START);
    });

    it("seller tidak bisa ship setelah deadline", async function () {
      const ctx = await fundedFixture();
      await time.increase(3 * DAY + 1);
      await expect(ship(ctx)).to.be.revertedWithCustomError(ctx.escrow, "DeadlinePassed");
    });
  });

  describe("ship + invoice", function () {
    it("mencatat invoice on-chain lengkap dengan item dan rincian biaya", async function () {
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

  describe("selesai normal", function () {
    it("buyer konfirmasi -> semua dana (barang + ongkir + gas) ke seller", async function () {
      const { escrow, token, buyer, seller, orderId, total } = await deliveredFixture();
      await expect(escrow.connect(buyer).confirmReceived(orderId))
        .to.emit(escrow, "Completed")
        .withArgs(orderId, total, false);
      expect(await token.balanceOf(seller.address)).to.equal(total);
    });

    it("buyer diam 3 hari -> autoRelease", async function () {
      const { escrow, token, seller, other, orderId, total } = await deliveredFixture();
      await expect(escrow.connect(other).autoRelease(orderId)).to.be.revertedWithCustomError(
        escrow,
        "DeadlineNotPassed",
      );
      await time.increase(3 * DAY + 1);
      expect(await escrow.pendingAutoAction(orderId)).to.equal(2);
      await escrow.connect(other).autoRelease(orderId);
      expect(await token.balanceOf(seller.address)).to.equal(total);
    });
  });

  describe("refund & retur", function () {
    it("refund di-pause timernya, ditolak -> lanjut dari sisa waktu", async function () {
      const { escrow, admin, buyer, orderId } = await deliveredFixture();
      await time.increase(1 * DAY);
      await escrow.connect(buyer).requestRefund(orderId);
      let o = await escrow.getOrder(orderId);
      expect(o.status).to.equal(Status.RefundRequested);
      const remaining = o.pausedRemaining;
      expect(remaining).to.be.closeTo(BigInt(2 * DAY), 5n);

      await time.increase(5 * DAY); // admin lama memutuskan, timer tidak berjalan
      await escrow.connect(admin).rejectRefund(orderId);
      o = await escrow.getOrder(orderId);
      expect(o.status).to.equal(Status.Delivered);
      expect(o.deadline - BigInt(await time.latest())).to.equal(remaining);
    });

    it("maksimal 3 kali pengajuan refund", async function () {
      const { escrow, admin, buyer, orderId } = await deliveredFixture();
      for (let i = 0; i < 3; i++) {
        await escrow.connect(buyer).requestRefund(orderId);
        await escrow.connect(admin).rejectRefund(orderId);
      }
      await expect(escrow.connect(buyer).requestRefund(orderId)).to.be.revertedWithCustomError(
        escrow,
        "RefundLimitReached",
      );
    });

    it("refund disetujui -> retur -> seller konfirmasi: barang+ongkir ke buyer, gas ke seller", async function () {
      const { escrow, token, admin, buyer, seller, orderId, gasFee } = await deliveredFixture();
      await escrow.connect(buyer).requestRefund(orderId);
      await expect(escrow.connect(admin).approveRefund(orderId)).to.emit(escrow, "RefundApproved");
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.ReturnPending);

      await escrow.connect(buyer).markReturnShipped(orderId);
      await escrow.connect(buyer).markReturnDelivered(orderId);
      await expect(escrow.connect(seller).confirmReturnReceived(orderId))
        .to.emit(escrow, "Refunded")
        .withArgs(orderId, ITEMS_TOTAL + SHIPPING, gasFee, false);

      expect(await token.balanceOf(buyer.address)).to.equal(START - gasFee);
      expect(await token.balanceOf(seller.address)).to.equal(gasFee);
    });

    it("buyer tidak kirim retur 3 hari -> refund batal, dana ke seller", async function () {
      const { escrow, token, admin, buyer, seller, other, orderId, total } = await deliveredFixture();
      await escrow.connect(buyer).requestRefund(orderId);
      await escrow.connect(admin).approveRefund(orderId);
      await time.increase(3 * DAY + 1);
      await expect(escrow.connect(buyer).markReturnShipped(orderId)).to.be.revertedWithCustomError(
        escrow,
        "DeadlinePassed",
      );
      expect(await escrow.pendingAutoAction(orderId)).to.equal(3);
      await expect(escrow.connect(other).expireReturn(orderId)).to.emit(escrow, "ReturnExpired");
      expect(await token.balanceOf(seller.address)).to.equal(total);
    });

    it("seller tidak konfirmasi retur 3 hari -> autoRefund", async function () {
      const { escrow, token, admin, buyer, other, orderId, gasFee } = await deliveredFixture();
      await escrow.connect(buyer).requestRefund(orderId);
      await escrow.connect(admin).approveRefund(orderId);
      await escrow.connect(buyer).markReturnShipped(orderId);
      await escrow.connect(buyer).markReturnDelivered(orderId);
      await time.increase(3 * DAY + 1);
      expect(await escrow.pendingAutoAction(orderId)).to.equal(4);
      await expect(escrow.connect(other).autoRefund(orderId))
        .to.emit(escrow, "Refunded")
        .withArgs(orderId, ITEMS_TOTAL + SHIPPING, gasFee, true);
      expect(await token.balanceOf(buyer.address)).to.equal(START - gasFee);
    });

    it("barang tak sampai 7 hari -> refund langsung tanpa retur", async function () {
      const ctx = await fundedFixture();
      const { escrow, token, admin, buyer, seller, orderId, gasFee } = ctx;
      await ship(ctx);
      await expect(escrow.connect(buyer).requestRefund(orderId)).to.be.revertedWithCustomError(
        escrow,
        "RefundNotAllowedYet",
      );
      await time.increase(7 * DAY);
      await escrow.connect(buyer).requestRefund(orderId);
      await expect(escrow.connect(admin).approveRefund(orderId))
        .to.emit(escrow, "Refunded")
        .withArgs(orderId, ITEMS_TOTAL + SHIPPING, gasFee, false);
      expect(await token.balanceOf(buyer.address)).to.equal(START - gasFee);
      expect(await token.balanceOf(seller.address)).to.equal(gasFee);
    });

    it("refund barang tak sampai ditolak -> kembali ke Shipped", async function () {
      const ctx = await fundedFixture();
      const { escrow, admin, buyer, orderId } = ctx;
      await ship(ctx);
      await time.increase(7 * DAY);
      await escrow.connect(buyer).requestRefund(orderId);
      await escrow.connect(admin).rejectRefund(orderId);
      expect((await escrow.getOrder(orderId)).status).to.equal(Status.Shipped);
    });

    it("hanya admin yang bisa approve / reject", async function () {
      const { escrow, buyer, other, orderId } = await deliveredFixture();
      await escrow.connect(buyer).requestRefund(orderId);
      await expect(escrow.connect(other).approveRefund(orderId)).to.be.revertedWithCustomError(
        escrow,
        "AccessControlUnauthorizedAccount",
      );
      await expect(escrow.connect(buyer).rejectRefund(orderId)).to.be.revertedWithCustomError(
        escrow,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("gas usage (untuk kalibrasi estimasi)", function () {
    it("mencetak gas markShipped & markDelivered", async function () {
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
        const shipTx = await escrow.connect(seller).markShipped(id, "INV-2026-ABCDEF", items, "J&T Express", "JT2610281234567");
        const shipGas = (await shipTx.wait()).gasUsed;
        const delTx = await escrow.connect(seller).markDelivered(id);
        const delGas = (await delTx.wait()).gasUsed;
        console.log(`      items=${n} markShipped=${shipGas} markDelivered=${delGas} total=${shipGas + delGas}`);
      }
    });
  });
});
