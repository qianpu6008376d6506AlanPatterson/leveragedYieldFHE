pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract LeveragedYieldFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidParameter();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();
    error InvalidBatch();

    struct Position {
        euint32 collateral; // Encrypted collateral amount
        euint32 debt;       // Encrypted debt amount
        euint32 leverage;   // Encrypted leverage multiplier (e.g., 2 for 2x)
    }

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    mapping(address => bool) public providers;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    mapping(uint256 => mapping(address => Position)) public encryptedPositions;
    mapping(uint256 => bool) public batchClosed;
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    address public owner;
    bool public paused;
    uint256 public cooldownSeconds;
    uint256 public currentBatchId;

    event OwnerChanged(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PausedStateChanged(bool paused);
    event CooldownSecondsChanged(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event PositionSubmitted(address indexed provider, uint256 indexed batchId, address indexed user);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 userCollateral, uint256 userDebt, uint256 userLeverage, uint256 healthFactor);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        cooldownSeconds = 60; // Default 1 minute cooldown
        currentBatchId = 1;   // Start with batch 1
        emit BatchOpened(currentBatchId);
    }

    function changeOwner(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnerChanged(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedStateChanged(_paused);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidParameter();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsChanged(oldCooldown, newCooldownSeconds);
    }

    function openNewBatch() external onlyOwner {
        batchClosed[currentBatchId] = true;
        emit BatchClosed(currentBatchId);
        currentBatchId++;
        emit BatchOpened(currentBatchId);
    }

    function submitEncryptedPosition(
        address user,
        euint32 encryptedCollateral,
        euint32 encryptedDebt,
        euint32 encryptedLeverage
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        _initIfNeeded(encryptedCollateral);
        _initIfNeeded(encryptedDebt);
        _initIfNeeded(encryptedLeverage);

        if (batchClosed[currentBatchId]) revert BatchClosed();

        encryptedPositions[currentBatchId][user] = Position({
            collateral: encryptedCollateral,
            debt: encryptedDebt,
            leverage: encryptedLeverage
        });

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit PositionSubmitted(msg.sender, currentBatchId, user);
    }

    function requestHealthFactorDecryption(address user) external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (batchClosed[currentBatchId]) revert BatchClosed();

        Position memory pos = encryptedPositions[currentBatchId][user];
        _requireInitialized(pos.collateral);
        _requireInitialized(pos.debt);
        _requireInitialized(pos.leverage);

        // 1. Prepare Ciphertexts
        // Order: collateral, debt, leverage, healthFactor
        bytes32[] memory cts = new bytes32[](4);
        cts[0] = FHE.toBytes32(pos.collateral);
        cts[1] = FHE.toBytes32(pos.debt);
        cts[2] = FHE.toBytes32(pos.leverage);

        // Calculate healthFactor = collateral / (debt * leverage)
        // This is a simplified representation. Actual FHE division is complex.
        // For this example, we'll assume a simplified calculation or that
        // the FHE library provides a way to compute this division.
        // Here, we'll just pass a placeholder ciphertext for healthFactor.
        // In a real scenario, this would be the result of the FHE computation.
        euint32 memory healthFactor = pos.collateral; // Placeholder
        cts[3] = FHE.toBytes32(healthFactor);


        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, currentBatchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        DecryptionContext storage ctx = decryptionContexts[requestId];

        // a. Replay Guard
        if (ctx.processed) revert ReplayDetected();

        // b. State Verification
        // Rebuild cts in the exact same order as in requestHealthFactorDecryption
        Position storage pos = encryptedPositions[ctx.batchId][msg.sender]; // Assuming msg.sender is the user
        _requireInitialized(pos.collateral);
        _requireInitialized(pos.debt);
        _requireInitialized(pos.leverage);

        bytes32[] memory currentCts = new bytes32[](4);
        currentCts[0] = FHE.toBytes32(pos.collateral);
        currentCts[1] = FHE.toBytes32(pos.debt);
        currentCts[2] = FHE.toBytes32(pos.leverage);

        euint32 memory currentHealthFactor = pos.collateral; // Placeholder, same as in request
        currentCts[3] = FHE.toBytes32(currentHealthFactor);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != ctx.stateHash) revert StateMismatch();
        // @dev: State hash verification ensures that the ciphertexts being decrypted
        // are the same ones that were committed to when the decryption was requested.
        // This prevents scenarios where ciphertexts might have changed after the request.

        // c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        // d. Decode & Finalize
        // Order: collateral, debt, leverage, healthFactor
        uint256 userCollateral = abi.decode(cleartexts[0:32], (uint256));
        uint256 userDebt = abi.decode(cleartexts[32:64], (uint256));
        uint256 userLeverage = abi.decode(cleartexts[64:96], (uint256));
        uint256 healthFactorValue = abi.decode(cleartexts[96:128], (uint256));

        ctx.processed = true;
        // @dev: Replay protection (ctx.processed flag) ensures this callback is not processed multiple times
        // for the same requestId, which could lead to double-spending or other issues.
        emit DecryptionCompleted(requestId, ctx.batchId, userCollateral, userDebt, userLeverage, healthFactorValue);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal {
        if (!FHE.isInitialized(x)) {
            // Initialize with a default value if not already initialized.
            // This is a placeholder; initialization strategy depends on the specific FHE scheme.
            // For Zama's FHE, ciphertexts are typically initialized upon encryption.
            // This check is more for defensive programming.
            revert NotInitialized();
        }
    }

    function _requireInitialized(euint32 x) internal pure {
        if (!FHE.isInitialized(x)) revert NotInitialized();
    }
}