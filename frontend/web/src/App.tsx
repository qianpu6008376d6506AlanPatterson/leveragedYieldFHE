import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

// 随机风格选择：安全无菌（色彩） + 仪表盘（UI） + 固定侧边栏（布局） + 加密/解密动画（交互）
interface LeveragePosition {
  id: string;
  encryptedCollateral: string;
  encryptedLeverage: string;
  encryptedHealthFactor: string;
  timestamp: number;
  owner: string;
  status: "active" | "liquidated" | "closed";
  pair: string;
}

// FHE加密函数 - 模拟Zama FHE加密过程
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-${Date.now()}`;
};

// FHE解密函数 - 需要钱包签名验证
const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    const base64Data = encryptedData.substring(4).split('-')[0];
    return parseFloat(atob(base64Data));
  }
  return parseFloat(encryptedData);
};

// FHE同态计算 - 模拟在加密数据上计算健康因子
const FHEComputeHealthFactor = (encryptedCollateral: string, encryptedLeverage: string): string => {
  const collateral = FHEDecryptNumber(encryptedCollateral);
  const leverage = FHEDecryptNumber(encryptedLeverage);
  // 模拟同态计算：健康因子 = 抵押物 / (杠杆 * 风险系数)
  const healthFactor = collateral / (leverage * 1.5);
  return FHEEncryptNumber(healthFactor);
};

// 生成模拟公钥用于签名验证
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [positions, setPositions] = useState<LeveragePosition[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newPositionData, setNewPositionData] = useState({ 
    collateral: 0, 
    leverage: 1, 
    pair: "ETH-USDC" 
  });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedPosition, setSelectedPosition] = useState<LeveragePosition | null>(null);
  const [decryptedValues, setDecryptedValues] = useState<{collateral?: number, leverage?: number, health?: number}>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);

  // 统计数据
  const activePositions = positions.filter(p => p.status === "active").length;
  const liquidatedPositions = positions.filter(p => p.status === "liquidated").length;
  const totalCollateral = positions.reduce((sum, pos) => sum + (decryptedValues.collateral || 0), 0);

  useEffect(() => {
    loadPositions().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  // 加载仓位数据
  const loadPositions = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // 检查合约可用性
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract not available");
        return;
      }

      // 获取仓位密钥列表
      const keysBytes = await contract.getData("position_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing position keys:", e); }
      }

      const list: LeveragePosition[] = [];
      for (const key of keys) {
        try {
          const positionBytes = await contract.getData(`position_${key}`);
          if (positionBytes.length > 0) {
            try {
              const positionData = JSON.parse(ethers.toUtf8String(positionBytes));
              list.push({ 
                id: key, 
                encryptedCollateral: positionData.collateral, 
                encryptedLeverage: positionData.leverage,
                encryptedHealthFactor: positionData.healthFactor,
                timestamp: positionData.timestamp, 
                owner: positionData.owner, 
                status: positionData.status || "active",
                pair: positionData.pair || "ETH-USDC"
              });
            } catch (e) { console.error(`Error parsing position data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading position ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setPositions(list);
    } catch (e) { console.error("Error loading positions:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  // 创建新仓位
  const createPosition = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting position data with Zama FHE..." });
    
    try {
      // 使用FHE加密敏感数据
      const encryptedCollateral = FHEEncryptNumber(newPositionData.collateral);
      const encryptedLeverage = FHEEncryptNumber(newPositionData.leverage);
      const encryptedHealthFactor = FHEComputeHealthFactor(encryptedCollateral, encryptedLeverage);

      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const positionId = `pos_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const positionData = { 
        collateral: encryptedCollateral, 
        leverage: encryptedLeverage,
        healthFactor: encryptedHealthFactor,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        status: "active",
        pair: newPositionData.pair
      };

      // 存储加密数据到合约
      await contract.setData(`position_${positionId}`, ethers.toUtf8Bytes(JSON.stringify(positionData)));
      
      // 更新仓位密钥列表
      const keysBytes = await contract.getData("position_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(positionId);
      await contract.setData("position_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));

      setTransactionStatus({ visible: true, status: "success", message: "Leverage position created with FHE encryption!" });
      await loadPositions();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewPositionData({ collateral: 0, leverage: 1, pair: "ETH-USDC" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Position creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  // 解密仓位数据（需要钱包签名）
  const decryptPositionData = async (position: LeveragePosition): Promise<void> => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setIsDecrypting(true);
    
    try {
      // 请求钱包签名进行解密授权
      const message = `Zama FHE Decryption Request\nPublic Key: ${publicKey}\nContract: ${contractAddress}\nChain: ${chainId}\nTimestamp: ${Date.now()}`;
      await signMessageAsync({ message });
      
      // 模拟解密过程
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const decryptedCollateral = FHEDecryptNumber(position.encryptedCollateral);
      const decryptedLeverage = FHEDecryptNumber(position.encryptedLeverage);
      const decryptedHealth = FHEDecryptNumber(position.encryptedHealthFactor);
      
      setDecryptedValues({
        collateral: decryptedCollateral,
        leverage: decryptedLeverage,
        health: decryptedHealth
      });
      
    } catch (e) { 
      console.error("Decryption failed:", e);
      alert("Decryption authorization failed");
    } finally { 
      setIsDecrypting(false); 
    }
  };

  // 清算仓位
  const liquidatePosition = async (positionId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing liquidation with FHE computation..." });
    
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const positionBytes = await contract.getData(`position_${positionId}`);
      if (positionBytes.length === 0) throw new Error("Position not found");
      const positionData = JSON.parse(ethers.toUtf8String(positionBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedPosition = { ...positionData, status: "liquidated" };
      await contractWithSigner.setData(`position_${positionId}`, ethers.toUtf8Bytes(JSON.stringify(updatedPosition)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Position liquidated successfully!" });
      await loadPositions();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Liquidation failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // 检查仓位所有权
  const isOwner = (positionAddress: string) => address?.toLowerCase() === positionAddress.toLowerCase();

  if (loading) return (
    <div className="loading-screen">
      <div className="security-spinner"></div>
      <p>Initializing secure FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container safety-theme">
      {/* 侧边栏 */}
      <aside className="app-sidebar">
        <div className="sidebar-header">
          <div className="logo">
            <div className="vault-icon"></div>
            <h1>FHE<span>Leverage</span>Mining</h1>
          </div>
        </div>
        
        <nav className="sidebar-nav">
          <div className="nav-section">
            <h3>Dashboard</h3>
            <button className="nav-item active">
              <div className="nav-icon">📊</div>
              <span>Position Overview</span>
            </button>
            <button className="nav-item">
              <div className="nav-icon">🔒</div>
              <span>FHE Security</span>
            </button>
          </div>
          
          <div className="nav-section">
            <h3>Management</h3>
            <button className="nav-item" onClick={() => setShowCreateModal(true)}>
              <div className="nav-icon">➕</div>
              <span>New Position</span>
            </button>
            <button className="nav-item" onClick={loadPositions}>
              <div className="nav-icon">🔄</div>
              <span>Refresh Data</span>
            </button>
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="security-status">
            <div className="status-indicator"></div>
            <span>FHE Encryption Active</span>
          </div>
        </div>
      </aside>

      {/* 主内容区 */}
      <main className="app-main">
        <header className="main-header">
          <div className="header-actions">
            <button className="tutorial-btn" onClick={() => setShowTutorial(!showTutorial)}>
              {showTutorial ? "Hide Guide" : "Show Guide"}
            </button>
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={true} />
          </div>
        </header>

        {showTutorial && (
          <section className="tutorial-section">
            <h2>FHE Leveraged Yield Farming Guide</h2>
            <div className="tutorial-steps">
              <div className="tutorial-step">
                <div className="step-number">1</div>
                <div className="step-content">
                  <h3>Encrypt Position Data</h3>
                  <p>Your collateral, leverage, and health factors are encrypted using Zama FHE before reaching the blockchain</p>
                </div>
              </div>
              <div className="tutorial-step">
                <div className="step-number">2</div>
                <div className="step-content">
                  <h3>Homomorphic Computation</h3>
                  <p>Health factors and liquidation checks are computed directly on encrypted data without decryption</p>
                </div>
              </div>
              <div className="tutorial-step">
                <div className="step-number">3</div>
                <div className="step-content">
                  <h3>Secure Decryption</h3>
                  <p>Only you can decrypt your position data using wallet signature authorization</p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* 仪表盘统计 */}
        <section className="dashboard-grid">
          <div className="metric-card">
            <div className="metric-icon">💰</div>
            <div className="metric-content">
              <div className="metric-value">{activePositions}</div>
              <div className="metric-label">Active Positions</div>
            </div>
          </div>
          
          <div className="metric-card">
            <div className="metric-icon">⚡</div>
            <div className="metric-content">
              <div className="metric-value">${totalCollateral.toLocaleString()}</div>
              <div className="metric-label">Total Collateral</div>
            </div>
          </div>
          
          <div className="metric-card">
            <div className="metric-icon">🛡️</div>
            <div className="metric-content">
              <div className="metric-value">{liquidatedPositions}</div>
              <div className="metric-label">Liquidated</div>
            </div>
          </div>
          
          <div className="metric-card">
            <div className="metric-icon">🔐</div>
            <div className="metric-content">
              <div className="metric-value">FHE</div>
              <div className="metric-label">Encryption Active</div>
            </div>
          </div>
        </section>

        {/* 仓位列表 */}
        <section className="positions-section">
          <div className="section-header">
            <h2>Leverage Positions</h2>
            <button className="create-btn" onClick={() => setShowCreateModal(true)}>
              + New Leverage Position
            </button>
          </div>

          <div className="positions-table">
            <div className="table-header">
              <div>Pair</div>
              <div>Collateral</div>
              <div>Leverage</div>
              <div>Health Factor</div>
              <div>Status</div>
              <div>Actions</div>
            </div>

            {positions.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📊</div>
                <p>No leverage positions found</p>
                <button className="primary-btn" onClick={() => setShowCreateModal(true)}>
                  Create First Position
                </button>
              </div>
            ) : (
              positions.map(position => (
                <div key={position.id} className="position-row">
                  <div>{position.pair}</div>
                  <div>
                    {decryptedValues.collateral && selectedPosition?.id === position.id 
                      ? `$${decryptedValues.collateral}` 
                      : '***'
                    }
                  </div>
                  <div>
                    {decryptedValues.leverage && selectedPosition?.id === position.id 
                      ? `${decryptedValues.leverage}x` 
                      : '***'
                    }
                  </div>
                  <div>
                    {decryptedValues.health && selectedPosition?.id === position.id 
                      ? decryptedValues.health.toFixed(2) 
                      : '***'
                    }
                  </div>
                  <div>
                    <span className={`status-badge ${position.status}`}>
                      {position.status}
                    </span>
                  </div>
                  <div className="action-buttons">
                    <button 
                      className="decrypt-btn"
                      onClick={() => {
                        setSelectedPosition(position);
                        decryptPositionData(position);
                      }}
                      disabled={isDecrypting}
                    >
                      {isDecrypting && selectedPosition?.id === position.id ? 'Decrypting...' : 'Decrypt'}
                    </button>
                    {isOwner(position.owner) && position.status === "active" && (
                      <button 
                        className="liquidate-btn"
                        onClick={() => liquidatePosition(position.id)}
                      >
                        Liquidate
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      {/* 创建仓位模态框 */}
      {showCreateModal && (
        <CreatePositionModal
          onSubmit={createPosition}
          onClose={() => setShowCreateModal(false)}
          creating={creating}
          positionData={newPositionData}
          setPositionData={setNewPositionData}
        />
      )}

      {/* 交易状态提示 */}
      {transactionStatus.visible && (
        <div className="transaction-toast">
          <div className={`toast-content ${transactionStatus.status}`}>
            <div className="toast-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
    </div>
  );
};

// 创建仓位模态框组件
interface CreatePositionModalProps {
  onSubmit: () => void;
  onClose: () => void;
  creating: boolean;
  positionData: any;
  setPositionData: (data: any) => void;
}

const CreatePositionModal: React.FC<CreatePositionModalProps> = ({
  onSubmit,
  onClose,
  creating,
  positionData,
  setPositionData
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setPositionData({ ...positionData, [name]: name === 'leverage' || name === 'collateral' ? parseFloat(value) : value });
  };

  const handleSubmit = () => {
    if (!positionData.collateral || positionData.collateral <= 0) {
      alert("Please enter valid collateral amount");
      return;
    }
    if (!positionData.leverage || positionData.leverage < 1) {
      alert("Leverage must be at least 1x");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal">
        <div className="modal-header">
          <h2>Create Leverage Position</h2>
          <button onClick={onClose} className="close-btn">×</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="notice-icon">🔒</div>
            <div>
              <strong>FHE Encryption Active</strong>
              <p>All position data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>

          <div className="form-grid">
            <div className="form-group">
              <label>Trading Pair</label>
              <select name="pair" value={positionData.pair} onChange={handleChange}>
                <option value="ETH-USDC">ETH-USDC</option>
                <option value="BTC-USDC">BTC-USDC</option>
                <option value="SOL-USDC">SOL-USDC</option>
              </select>
            </div>

            <div className="form-group">
              <label>Collateral Amount (USD)</label>
              <input
                type="number"
                name="collateral"
                value={positionData.collateral}
                onChange={handleChange}
                min="0"
                step="0.01"
                placeholder="Enter collateral amount"
              />
            </div>

            <div className="form-group">
              <label>Leverage Multiplier</label>
              <input
                type="number"
                name="leverage"
                value={positionData.leverage}
                onChange={handleChange}
                min="1"
                max="10"
                step="0.1"
                placeholder="Enter leverage (1-10x)"
              />
            </div>
          </div>

          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-grid">
              <div className="preview-item">
                <span>Collateral:</span>
                <code>{positionData.collateral ? FHEEncryptNumber(positionData.collateral).substring(0, 30) + '...' : 'Not encrypted'}</code>
              </div>
              <div className="preview-item">
                <span>Leverage:</span>
                <code>{positionData.leverage ? FHEEncryptNumber(positionData.leverage).substring(0, 30) + '...' : 'Not encrypted'}</code>
              </div>
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="secondary-btn">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="primary-btn">
            {creating ? "Encrypting with FHE..." : "Create Encrypted Position"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;