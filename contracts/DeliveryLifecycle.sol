// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DeliveryLifecycle
/// @notice Фиксирует в блокчейне жизненный цикл доставки АС сервиса доставки:
///         создание -> назначение курьера -> начало доставки -> завершение (или отмена).
///         Backend сервиса доставки (заказы, товары, адреса, оплата) остаётся
///         вне контракта: в блокчейн вынесены только статус доставки, участники
///         и контроль допустимых действий.
contract DeliveryLifecycle {
    // ------------------------------------------------------------------
    // Типы
    // ------------------------------------------------------------------

    /// Роли пользователей АС сервиса доставки
    enum Role {
        None,      // 0 – роль не назначена
        Customer,  // 1 – клиент, оформивший заказ
        Courier,   // 2 – курьер, выполняющий доставку
        Operator   // 3 – оператор (диспетчер) сервиса доставки
    }

    /// Состояния доставки
    enum Status {
        Created,   // 0 – доставка создана по заказу
        Accepted,  // 1 – назначен курьер, доставка принята в работу
        InTransit, // 2 – курьер забрал заказ и находится в пути
        Delivered, // 3 – заказ вручён клиенту
        Cancelled  // 4 – доставка отменена
    }

    /// Сведения о доставке
    struct Delivery {
        uint256 deliveryId;
        uint256 orderId;    // идентификатор заказа в backend BootcampLabs
        address customer;
        address courier;
        uint256 price;      // стоимость доставки (в копейках)
        Status status;
        uint64 createdAt;
        uint64 updatedAt;
    }

    // ------------------------------------------------------------------
    // Хранилище
    // ------------------------------------------------------------------

    address public immutable admin;
    uint256 public deliveriesCount;

    mapping(address => Role) public roles;
    mapping(uint256 => Delivery) private deliveries;      // deliveryId => доставка
    mapping(uint256 => uint256) public deliveryByOrder;   // orderId => deliveryId

    // ------------------------------------------------------------------
    // События
    // ------------------------------------------------------------------

    event RoleGranted(address indexed account, Role role, address indexed grantedBy);
    event DeliveryCreated(
        uint256 indexed deliveryId,
        uint256 indexed orderId,
        address indexed customer,
        uint256 price
    );
    event CourierAssigned(
        uint256 indexed deliveryId, address indexed courier, address indexed operator
    );
    event DeliveryStatusChanged(
        uint256 indexed deliveryId,
        Status oldStatus,
        Status newStatus,
        address indexed changedBy
    );

    // ------------------------------------------------------------------
    // Пользовательские ошибки
    // ------------------------------------------------------------------

    error ZeroAddress();
    error InvalidPrice();
    error AccessDenied(address caller, Role required, Role actual);
    error NotAssignedCourier(uint256 deliveryId, address caller, address courier);
    error NotDeliveryCustomer(uint256 deliveryId, address caller);
    error DeliveryNotFound(uint256 deliveryId);
    error OrderAlreadyHasDelivery(uint256 orderId, uint256 deliveryId);
    error InvalidTransition(uint256 deliveryId, Status from, Status to);
    error AccountIsNotCourier(address account);

    // ------------------------------------------------------------------
    // Модификаторы
    // ------------------------------------------------------------------

    modifier onlyRole(Role required) {
        if (roles[msg.sender] != required) {
            revert AccessDenied(msg.sender, required, roles[msg.sender]);
        }
        _;
    }

    modifier deliveryExists(uint256 deliveryId) {
        if (deliveryId == 0 || deliveryId > deliveriesCount) {
            revert DeliveryNotFound(deliveryId);
        }
        _;
    }

    modifier onlyAssignedCourier(uint256 deliveryId) {
        address courier = deliveries[deliveryId].courier;
        if (msg.sender != courier) {
            revert NotAssignedCourier(deliveryId, msg.sender, courier);
        }
        _;
    }

    // ------------------------------------------------------------------
    // Конструктор и управление ролями
    // ------------------------------------------------------------------

    constructor() {
        admin = msg.sender;
        roles[msg.sender] = Role.Operator;
        emit RoleGranted(msg.sender, Role.Operator, msg.sender);
    }

    /// Назначение роли пользователю. Доступно только оператору.
    function grantRole(address account, Role role) external onlyRole(Role.Operator) {
        if (account == address(0)) revert ZeroAddress();
        require(account != admin, "Admin role cannot be changed");
        roles[account] = role;
        emit RoleGranted(account, role, msg.sender);
    }

    // ------------------------------------------------------------------
    // Жизненный цикл доставки
    // ------------------------------------------------------------------

    /// Клиент регистрирует доставку по своему заказу.
    function createDelivery(uint256 orderId, uint256 price)
        external
        onlyRole(Role.Customer)
        returns (uint256 deliveryId)
    {
        require(orderId > 0, "Order id must be positive");
        if (price == 0) revert InvalidPrice();
        uint256 existing = deliveryByOrder[orderId];
        if (existing != 0) revert OrderAlreadyHasDelivery(orderId, existing);

        deliveryId = ++deliveriesCount;
        deliveries[deliveryId] = Delivery({
            deliveryId: deliveryId,
            orderId: orderId,
            customer: msg.sender,
            courier: address(0),
            price: price,
            status: Status.Created,
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp)
        });
        deliveryByOrder[orderId] = deliveryId;

        emit DeliveryCreated(deliveryId, orderId, msg.sender, price);
    }

    /// Оператор назначает курьера: Created -> Accepted.
    function assignCourier(uint256 deliveryId, address courier)
        external
        onlyRole(Role.Operator)
        deliveryExists(deliveryId)
    {
        if (courier == address(0)) revert ZeroAddress();
        if (roles[courier] != Role.Courier) revert AccountIsNotCourier(courier);

        deliveries[deliveryId].courier = courier;
        _changeStatus(deliveryId, Status.Accepted);
        emit CourierAssigned(deliveryId, courier, msg.sender);
    }

    /// Назначенный курьер забирает заказ: Accepted -> InTransit.
    function startDelivery(uint256 deliveryId)
        external
        onlyRole(Role.Courier)
        deliveryExists(deliveryId)
        onlyAssignedCourier(deliveryId)
    {
        _changeStatus(deliveryId, Status.InTransit);
    }

    /// Только назначенный курьер завершает доставку: InTransit -> Delivered.
    function completeDelivery(uint256 deliveryId)
        external
        onlyRole(Role.Courier)
        deliveryExists(deliveryId)
        onlyAssignedCourier(deliveryId)
    {
        _changeStatus(deliveryId, Status.Delivered);
    }

    /// Отмена доставки клиентом-владельцем или оператором.
    /// Допустима только до начала доставки (Created или Accepted).
    function cancelDelivery(uint256 deliveryId) external deliveryExists(deliveryId) {
        Role role = roles[msg.sender];
        if (role == Role.Customer) {
            if (deliveries[deliveryId].customer != msg.sender) {
                revert NotDeliveryCustomer(deliveryId, msg.sender);
            }
        } else if (role != Role.Operator) {
            revert AccessDenied(msg.sender, Role.Operator, role);
        }
        _changeStatus(deliveryId, Status.Cancelled);
    }

    // ------------------------------------------------------------------
    // Чтение данных
    // ------------------------------------------------------------------

    function getDelivery(uint256 deliveryId)
        external
        view
        deliveryExists(deliveryId)
        returns (Delivery memory)
    {
        return deliveries[deliveryId];
    }

    function getStatus(uint256 deliveryId)
        external
        view
        deliveryExists(deliveryId)
        returns (Status)
    {
        return deliveries[deliveryId].status;
    }

    /// Таблица допустимых переходов между состояниями
    function canTransition(Status from, Status to) public pure returns (bool) {
        if (from == Status.Created)  return to == Status.Accepted  || to == Status.Cancelled;
        if (from == Status.Accepted) return to == Status.InTransit || to == Status.Cancelled;
        if (from == Status.InTransit) return to == Status.Delivered;
        return false; // Delivered и Cancelled – конечные состояния
    }

    // ------------------------------------------------------------------
    // Внутренняя логика
    // ------------------------------------------------------------------

    function _changeStatus(uint256 deliveryId, Status newStatus) private {
        Delivery storage d = deliveries[deliveryId];
        Status oldStatus = d.status;
        if (!canTransition(oldStatus, newStatus)) {
            revert InvalidTransition(deliveryId, oldStatus, newStatus);
        }
        d.status = newStatus;
        d.updatedAt = uint64(block.timestamp);
        emit DeliveryStatusChanged(deliveryId, oldStatus, newStatus, msg.sender);
    }
}
