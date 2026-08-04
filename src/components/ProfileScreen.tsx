import { useState } from "react";

export interface FocusHistoryItem {
  id: string;
  title: string;
  durationMinutes: number;
  completedAt: string;
  rewardCoins: number;
}

interface StoreItem {
  id: string;
  name: string;
  description: string;
  price: number;
  unlocked: boolean;
  accent: string;
  preview: "halo" | "ring" | "eyes" | "trail" | "aura";
}

interface ProfileScreenProps {
  history: FocusHistoryItem[];
  coins: number;
  onBack: () => void;
}

const STORE_ITEMS: StoreItem[] = [
  { id: "mint-halo", name: "Mint Halo", description: "Soft mint orbit", price: 0, unlocked: true, accent: "#7ef2d0", preview: "halo" },
  { id: "lunar-ring", name: "Lunar Ring", description: "Silver edge light", price: 120, unlocked: true, accent: "#dce9ff", preview: "ring" },
  { id: "pixel-eyes", name: "Pixel Eyes", description: "A sharper expression", price: 260, unlocked: false, accent: "#a69cff", preview: "eyes" },
  { id: "comet-trail", name: "Comet Trail", description: "A trace for every hop", price: 380, unlocked: false, accent: "#ffcc83", preview: "trail" },
  { id: "aurora", name: "Aurora Aura", description: "Limited atmosphere", price: 520, unlocked: false, accent: "#7ee8ff", preview: "aura" },
];

const formatHistoryDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) return `Today · ${date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="profile-back" type="button" onClick={onClick} aria-label={label}>
      <span aria-hidden="true">‹</span>
    </button>
  );
}

function HistoryList({ history, compact = false }: { history: FocusHistoryItem[]; compact?: boolean }) {
  if (history.length === 0) {
    return (
      <div className="profile-empty">
        <span className="profile-empty__ring" aria-hidden="true"><i /></span>
        <strong>Your first focus is waiting.</strong>
        <small>Completed sessions will appear here.</small>
      </div>
    );
  }

  return (
    <div className={`history-list ${compact ? "history-list--compact" : ""}`}>
      {history.map((item) => (
        <article className="history-item" key={item.id}>
          <span className="history-item__status" aria-hidden="true">✓</span>
          <div className="history-item__copy">
            <strong>{item.title}</strong>
            <small>{formatHistoryDate(item.completedAt)}</small>
          </div>
          <div className="history-item__meta">
            <strong>{item.durationMinutes}</strong>
            <small>mins</small>
          </div>
        </article>
      ))}
    </div>
  );
}

function StorePreview({ item }: { item: StoreItem }) {
  return (
    <span className={`store-preview store-preview--${item.preview}`} style={{ "--item-accent": item.accent } as React.CSSProperties} aria-hidden="true">
      <i /><i />
    </span>
  );
}

function StoreList({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`store-list ${compact ? "store-list--compact" : ""}`}>
      {STORE_ITEMS.map((item) => (
        <article className={`store-item ${item.unlocked ? "is-unlocked" : "is-locked"}`} key={item.id}>
          <StorePreview item={item} />
          <div className="store-item__copy">
            <strong>{item.name}</strong>
            <small>{item.description}</small>
          </div>
          {item.unlocked ? (
            <span className="store-item__owned">OWNED</span>
          ) : (
            <span className="store-item__price"><i aria-hidden="true" />{item.price}</span>
          )}
          {!item.unlocked && <span className="store-item__lock" aria-label="Locked">▣</span>}
        </article>
      ))}
    </div>
  );
}

export default function ProfileScreen({ history, coins, onBack }: ProfileScreenProps) {
  const [page, setPage] = useState<"overview" | "history" | "store">("overview");
  const totalMinutes = history.reduce((sum, item) => sum + item.durationMinutes, 0);

  if (page !== "overview") {
    const isHistory = page === "history";
    return (
      <main className="profile-screen profile-screen--detail" data-testid={`profile-${page}`}>
        <div className="profile-ambient" aria-hidden="true" />
        <header className="profile-detail-header">
          <BackButton label="Back to profile" onClick={() => setPage("overview")} />
          <div>
            <small>{isHistory ? `${history.length} completed` : "Decorate your focus"}</small>
            <h1>{isHistory ? "History" : "Store"}</h1>
          </div>
          {!isHistory && <span className="profile-coins"><i aria-hidden="true" />{coins}</span>}
        </header>
        <section className="profile-detail-content">
          {isHistory ? <HistoryList history={history} /> : <StoreList />}
        </section>
      </main>
    );
  }

  return (
    <main className="profile-screen" data-testid="profile-screen">
      <div className="profile-ambient" aria-hidden="true" />
      <header className="profile-header">
        <BackButton label="Back to focus setup" onClick={onBack} />
        <div>
          <h1>Profile</h1>
        </div>
        <span className="profile-avatar" aria-hidden="true"><i /><i /></span>
      </header>

      <section className="profile-widget profile-widget--history" aria-labelledby="profile-history-title">
        <button className="profile-widget__header" type="button" onClick={() => setPage("history")}>
          <span>
            <small>{totalMinutes} mins focused</small>
            <strong id="profile-history-title">History</strong>
          </span>
          <i aria-hidden="true">›</i>
        </button>
        <div className="profile-widget__scroll" tabIndex={0} aria-label="Recent focus history">
          <HistoryList history={history} compact />
        </div>
      </section>

      <section className="profile-widget profile-widget--store" aria-labelledby="profile-store-title">
        <button className="profile-widget__header" type="button" onClick={() => setPage("store")}>
          <span>
            <small>Make it yours</small>
            <strong id="profile-store-title">Store</strong>
          </span>
          <span className="profile-coins"><i aria-hidden="true" />{coins}</span>
          <i aria-hidden="true">›</i>
        </button>
        <div className="profile-widget__scroll" tabIndex={0} aria-label="Store decorations">
          <StoreList compact />
        </div>
      </section>
    </main>
  );
}
