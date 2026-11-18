// Локальная проверка контракта DeliveryLifecycle:
// компиляция solc 0.8.24, развёртывание в Ganache, успешный сценарий и запрещённые операции.
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const ganache = require("ganache");
const { ethers } = require("ethers");

const STATUS = ["Created", "Accepted", "InTransit", "Delivered", "Cancelled"];
const ROLE = ["None", "Customer", "Courier", "Operator"];
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : a);
const section = process.argv[2] || "all";
const show = (s) => section === "all" || section === s;

function compile() {
  const file = path.join(__dirname, "..", "contracts", "DeliveryLifecycle.sol");
  const input = {
    language: "Solidity",
    sources: { "DeliveryLifecycle.sol": { content: fs.readFileSync(file, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "shanghai",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["DeliveryLifecycle.sol"].DeliveryLifecycle;
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, warnings: (out.errors || []).length };
}

function fmtArg(name, v) {
  if (typeof v === "bigint") {
    if (/status|^from$|^to$/i.test(name)) return STATUS[Number(v)];
    if (/role|required|actual/i.test(name)) return ROLE[Number(v)];
    return v.toString();
  }
  if (typeof v === "string" && v.startsWith("0x") && v.length === 42) return short(v);
  return String(v);
}

function printEvents(iface, receipt) {
  for (const log of receipt.logs) {
    const ev = iface.parseLog(log);
    if (!ev) continue;
    const args = ev.fragment.inputs.map((inp, i) => `${inp.name}=${fmtArg(inp.name, ev.args[i])}`);
    console.log(`      event ${ev.name}(${args.join(", ")})`);
  }
}

async function main() {
  const { abi, bytecode, warnings } = compile();
  const iface = new ethers.Interface(abi);
  if (show("deploy")) {
    console.log("$ node scripts/run-scenario.js");
    console.log("== Компиляция ==");
    console.log(`  solc ${solc.version()}`);
    console.log(`  DeliveryLifecycle.sol скомпилирован: ошибок 0, предупреждений ${warnings}, bytecode ${(bytecode.length - 2) / 2} байт`);
  }

  const provider = new ethers.BrowserProvider(
    ganache.provider({ logging: { quiet: true }, wallet: { deterministic: true }, chain: { hardfork: "shanghai" } })
  );
  const [operator, customer, courier, courier2, stranger] = await Promise.all(
    [0, 1, 2, 3, 4].map((i) => provider.getSigner(i))
  );
  const who = new Map([
    [operator.address, "operator"], [customer.address, "customer"], [courier.address, "courier"],
    [courier2.address, "courier2"], [stranger.address, "stranger"],
  ]);

  const factory = new ethers.ContractFactory(abi, bytecode, operator);
  const contract = await factory.deploy();
  const deployRcpt = await contract.deploymentTransaction().wait();
  const address = await contract.getAddress();

  if (show("deploy")) {
    console.log("== Развёртывание (Ganache, локальная сеть chainId 1337) ==");
    for (const [a, n] of who) console.log(`  ${n.padEnd(9)} ${a}`);
    console.log(`  contract  ${address}`);
    console.log(`  deploy tx ${deployRcpt.hash}  block #${deployRcpt.blockNumber}  gasUsed ${deployRcpt.gasUsed}  status ${deployRcpt.status === 1 ? "OK" : "FAIL"}`);
  }

  async function tx(label, signer, fn, ...args) {
    const r = await (await contract.connect(signer)[fn](...args)).wait();
    if (show(currentSection)) {
      console.log(`  [${who.get(signer.address)}] ${fn}(${args.map((a) => (typeof a === "string" ? short(a) : a)).join(", ")})`);
      console.log(`      tx ${r.hash.slice(0, 18)}…  block #${r.blockNumber}  gasUsed ${r.gasUsed}  status ${r.status === 1 ? "✔ success" : "✘ reverted"}  — ${label}`);
      printEvents(iface, r);
    }
    return r;
  }

  async function forbidden(label, signer, fn, ...args) {
    const c = contract.connect(signer);
    let decoded = "—";
    try {
      await c[fn].staticCall(...args);
      decoded = "НЕ ОТКЛОНЕНО (ошибка проверки!)";
    } catch (e) {
      const data = e.data || e.info?.error?.data?.data || e.info?.error?.data;
      if (e.revert) {
        decoded = `${e.revert.name}(${e.revert.args.map((v, i) => fmtArg(c.interface.getError(e.revert.name).inputs[i]?.name || "", v)).join(", ")})`;
      } else if (e.reason) decoded = `Error("${e.reason}")`;
      else decoded = String(data || e.message).slice(0, 80);
    }
    // Отправляем транзакцию с явным gasLimit, чтобы она попала в блок и была отклонена EVM
    const sent = await c[fn](...args, { gasLimit: 300000 });
    let rcpt;
    try { rcpt = await sent.wait(); } catch (e) { rcpt = e.receipt; }
    if (show(currentSection)) {
      console.log(`  [${who.get(signer.address)}] ${fn}(${args.map((a) => (typeof a === "string" ? short(a) : a)).join(", ")})  — ${label}`);
      console.log(`      tx ${rcpt.hash.slice(0, 18)}…  block #${rcpt.blockNumber}  status ${rcpt.status === 1 ? "✔ success" : "✘ reverted"}`);
      console.log(`      revert ${decoded}`);
    }
  }

  async function printDelivery(id) {
    const d = await contract.getDelivery(id);
    console.log(`  getDelivery(${id}) → { deliveryId: ${d.deliveryId}, orderId: ${d.orderId}, customer: ${short(d.customer)}, courier: ${short(d.courier)}, price: ${d.price}, status: ${STATUS[Number(d.status)]} }`);
  }

  // --- Роли ---
  let currentSection = "deploy";
  if (show("deploy")) console.log("== Назначение ролей (оператор) ==");
  await tx("клиент", operator, "grantRole", customer.address, 1);
  await tx("курьер", operator, "grantRole", courier.address, 2);
  await tx("второй курьер", operator, "grantRole", courier2.address, 2);

  // --- Успешный сценарий ---
  currentSection = "success";
  if (show("success")) console.log("== Успешный сценарий: доставка №1 по заказу 1024 ==");
  await tx("создание доставки", customer, "createDelivery", 1024, 34900);
  if (show("success")) await printDelivery(1);
  await tx("назначение курьера", operator, "assignCourier", 1, courier.address);
  await tx("начало доставки", courier, "startDelivery", 1);
  await tx("завершение доставки", courier, "completeDelivery", 1);
  if (show("success")) {
    await printDelivery(1);
    const logs = await contract.queryFilter(contract.filters.DeliveryStatusChanged(1));
    console.log("  История статусов доставки №1 (по событиям DeliveryStatusChanged):");
    for (const l of logs) console.log(`      block #${l.blockNumber}: ${STATUS[Number(l.args.oldStatus)]} → ${STATUS[Number(l.args.newStatus)]} (${who.get(l.args.changedBy)})`);
  }

  // --- Запрещённые операции ---
  currentSection = "forbidden";
  if (show("forbidden")) console.log("== Запрещённые операции: доставка №2 по заказу 2048 ==");
  await tx("создание доставки", customer, "createDelivery", 2048, 19900);
  if (show("forbidden")) console.log(`  canTransition(Created, Delivered) → ${await contract.canTransition(0, 3)}`);
  await forbidden("клиент пытается начать доставку", customer, "startDelivery", 2);
  await forbidden("оператор назначает курьером клиента", operator, "assignCourier", 2, customer.address);
  await tx("назначение курьера", operator, "assignCourier", 2, courier.address);
  await forbidden("завершение без начала (Accepted → Delivered)", courier, "completeDelivery", 2);
  await forbidden("чужой курьер начинает доставку", courier2, "startDelivery", 2);
  await tx("начало доставки", courier, "startDelivery", 2);
  await forbidden("отмена после начала доставки", customer, "cancelDelivery", 2);
  await forbidden("посторонний назначает себе роль", stranger, "grantRole", stranger.address, 3);
  await forbidden("повторная доставка по заказу 1024", customer, "createDelivery", 1024, 100);
  if (show("forbidden")) await printDelivery(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
