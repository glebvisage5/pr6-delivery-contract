# pr6-delivery-contract

Смарт-контракт `DeliveryLifecycle` (Solidity 0.8.24): жизненный цикл доставки АС сервиса доставки
Created → Accepted → InTransit → Delivered / Cancelled с ролями Customer, Courier, Operator.

- `contracts/DeliveryLifecycle.sol` – исходный код (открывается и разворачивается в Remix IDE).
- `scripts/run-scenario.js` – локальная проверка: компиляция solc, развёртывание в Ganache,
  успешный сценарий и запрещённые операции.

```
npm install
node scripts/run-scenario.js            # весь вывод
node scripts/run-scenario.js success    # только успешный сценарий
node scripts/run-scenario.js forbidden  # только запрещённые операции
```
