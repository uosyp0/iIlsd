import {readFile, writeFile, mkdir, stat, copyFile} from 'node:fs/promises';
import {createHash, createHmac, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createServer as createNetServer} from 'node:net';

// ============================================================================
// BOT DIRECT LINK GENERATOR & ENCRYPTED PAYLOAD MODULE (Node.js + Python)
// Generates long encrypted URLs for Telegram Bot -> MiniApp 0ms handoff:
// Format: https://robin-jeep-pantomime.ngrok-free.dev/?k=<telegramId>.<sig32>.<encryptedHexPayload>
// Short format also supported: https://robin-jeep-pantomime.ngrok-free.dev/?k=<telegramId>.<sig32>
// ============================================================================

export function botStreamKeyByte(uid, sig32, index) {
  const cleanSig = (sig32 || '7f91eca3b4521298a5e62ecf1c264f53').toLowerCase().padEnd(32, '0');
  const sByte = parseInt(cleanSig.slice((index % 16) * 2, (index % 16) * 2 + 2), 16) || 0x5a;
  const sByte2 = parseInt(cleanSig.slice(((index + 7) % 16) * 2, ((index + 7) % 16) * 2 + 2), 16) || 0xa5;
  let uHash = 0x811c9dc5;
  const seedStr = uid + ':' + cleanSig + ':' + String(index >> 4);
  for (let i = 0; i < seedStr.length; i++) {
    uHash ^= seedStr.charCodeAt(i);
    uHash = Math.imul(uHash, 0x01000193) >>> 0;
  }
  const shift = (index & 3) * 8;
  const prngByte = (uHash >>> shift) & 0xff;
  return (sByte ^ sByte2 ^ prngByte ^ ((index * 73 + 19) & 0xff)) & 0xff;
}

export function encryptBotPayloadHex(jsonText, uid, sig32) {
  const bytes = Buffer.from(jsonText, 'utf8');
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const enc = (bytes[i] ^ botStreamKeyByte(uid, sig32, i)) & 0xff;
    hex += enc.toString(16).padStart(2, '0');
  }
  return hex;
}

export function decryptBotPayloadHex(hexText, uid, sig32) {
  if (!hexText || hexText.length < 4 || hexText.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hexText)) return null;
  try {
    const out = Buffer.alloc(hexText.length / 2);
    for (let i = 0; i < out.length; i++) {
      const b = parseInt(hexText.slice(i * 2, i * 2 + 2), 16);
      out[i] = (b ^ botStreamKeyByte(uid, sig32, i)) & 0xff;
    }
    return out.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Generates a signed & encrypted long URL for the Telegram Bot to open the MiniApp
 * with user profile, nickname, username, UAH (₴) balance, and GRAM balance pre-embedded
 * so the MiniApp does not need to wait on tunnel reads.
 */
export function createBotDirectLink({
  baseUrl = process.env.MINIAPP_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://robin-jeep-pantomime.ngrok-free.dev',
  secret = process.env.BOT_BRIDGE_SECRET || process.env.BOT_TOKEN || 'legit_assets_bot_secret',
  telegramId,
  username = '',
  firstName = '',
  lastName = '',
  nickname = '',
  balanceUAH = '0.00',
  balanceGRAM = '0.000000000',
  locale = 'uk',
  rateGRAMUAH = undefined,
  isAdmin = false,
  orders = [],
  shortOnly = false,
}) {
  const uid = String(telegramId || '').trim();
  if (!/^[1-9]\d{4,15}$/.test(uid)) {
    throw new Error('Invalid telegramId: must be a numeric Telegram user ID (5-16 digits)');
  }
  const sig32 = createHmac('sha256', String(secret))
    .update(`legit_bot_direct:${uid}`)
    .digest('hex')
    .slice(0, 32);

  const cleanOrigin = String(baseUrl || 'https://robin-jeep-pantomime.ngrok-free.dev').replace(/\/+$/, '');
  if (shortOnly) {
    return `${cleanOrigin}/?k=${uid}.${sig32}`;
  }

  const displayNick = String(nickname || firstName || username || `User ${uid.slice(-4)}`).slice(0, 64);
  const payload = {
    v: 2,
    uid,
    un: String(username || '').replace(/^@/, '').slice(0, 64) || undefined,
    fn: String(firstName || '').slice(0, 64) || undefined,
    ln: String(lastName || '').slice(0, 64) || undefined,
    nick: displayNick,
    uah: Number(balanceUAH || 0).toFixed(2),
    gram: Number(balanceGRAM || 0).toFixed(9),
    lc: ['uk', 'ru', 'en'].includes(locale) ? locale : 'uk',
    rate: typeof rateGRAMUAH === 'number' && rateGRAMUAH > 0 ? rateGRAMUAH : undefined,
    vip: true,
    admin: Boolean(isAdmin),
    orders: Array.isArray(orders) && orders.length > 0 ? orders.slice(0, 20) : undefined,
    ts: Math.floor(Date.now() / 1000),
  };

  const encryptedHex = encryptBotPayloadHex(JSON.stringify(payload), uid, sig32);
  return `${cleanOrigin}/?k=${uid}.${sig32}.${encryptedHex}`;
}

export const PYTHON_BOT_LINK_MODULE = `# -*- coding: utf-8 -*-
"""
Плагін генерації захищених довгих посилань для Telegram-бота -> MiniApp (Legit Assets / Legit Assets).

Що робить цей плагін:
1. Формує підписане та зашифроване довге посилання вигляду:
   https://robin-jeep-pantomime.ngrok-free.dev/?k=<telegram_id>.<sig32>.<encrypted_hex_payload>
2. Вшиває прямо в посилання:
   - Telegram ID (uid)
   - @username (un), Ім'я (fn), Прізвище (ln) та відображуваний нікнейм (nick)
   - Баланс у гривнях (uah, ₴) та баланс у грамах (gram, 💎 GRAM)
   - Поточний курс GRAM/UAH (опціонально) та список останніх замовлень (orders)
3. Завдяки цьому MiniApp відкривається за 0 мс одразу з профілем і балансами користувача
   без потреби чекати відповіді від тунелю бота.
4. Якщо хтось відкриває сайт без цього посилання (просто https://robin-jeep-pantomime.ngrok-free.dev/),
   сайт автоматично показує QR-код і 3D-лендінг.
5. Містить готові хелпери для підключення в:
   - Aiogram 3.x / 2.x
   - pyTelegramBotAPI (TeleBot)
   - python-telegram-bot
   - Автоматичне зчитування балансів із локальної SQLite бази бота (якщо використовується SQLite)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import time
from typing import Any, Dict, List, Optional, Tuple, Union

# Базові налаштування (можна перевизначити через змінні середовища у .env бота)
DEFAULT_MINIAPP_URL = os.getenv("MINIAPP_BASE_URL", "https://robin-jeep-pantomime.ngrok-free.dev").rstrip("/")
DEFAULT_BOT_SECRET = (
    os.getenv("BOT_BRIDGE_SECRET")
    or os.getenv("BOT_TOKEN")
    or "legit_assets_bot_secret"
)


# ============================================================================
# 1. ЯДРО ШИФРУВАННЯ ТА ПІДПИСУ ПОСИЛАННЯ (?k=...)
# ============================================================================

def _stream_key_byte(uid: str, sig32: str, index: int) -> int:
    """Генерує байт потокового ключа на основі Telegram ID та 32-символьного підпису посилання (FNV-1a PRNG)."""
    clean_sig = (sig32 or "7f91eca3b4521298a5e62ecf1c264f53").lower().ljust(32, "0")
    try:
        s_byte = int(clean_sig[(index % 16) * 2 : (index % 16) * 2 + 2], 16)
    except ValueError:
        s_byte = 0x5A
    try:
        s_byte2 = int(clean_sig[((index + 7) % 16) * 2 : ((index + 7) % 16) * 2 + 2], 16)
    except ValueError:
        s_byte2 = 0xA5

    u_hash = 0x811C9DC5
    seed_str = f"{uid}:{clean_sig}:{index >> 4}"
    for char in seed_str:
        u_hash ^= ord(char)
        u_hash = ((u_hash & 0xFFFFFFFF) * 0x01000193) & 0xFFFFFFFF

    shift = (index & 3) * 8
    prng_byte = (u_hash >> shift) & 0xFF
    return (s_byte ^ s_byte2 ^ prng_byte ^ ((index * 73 + 19) & 0xFF)) & 0xFF


def encrypt_bot_payload_hex(json_text: str, uid: str, sig32: str) -> str:
    """Шифрує JSON-рядок із балансами та профілем у HEX-рядок, прив'язаний до uid та sig32."""
    raw = json_text.encode("utf-8")
    out = bytearray(len(raw))
    for i, b in enumerate(raw):
        out[i] = b ^ _stream_key_byte(uid, sig32, i)
    return bytes(out).hex()


def decrypt_bot_payload_hex(hex_text: str, uid: str, sig32: str) -> Optional[Dict[str, Any]]:
    """Розшифровує HEX-рядок назад у словник Python (для перевірки та тестів)."""
    if not hex_text or len(hex_text) < 4 or len(hex_text) % 2 != 0:
        return None
    try:
        raw = bytes.fromhex(hex_text)
        out = bytearray(len(raw))
        for i, b in enumerate(raw):
            out[i] = b ^ _stream_key_byte(uid, sig32, i)
        return json.loads(out.decode("utf-8"))
    except Exception:
        return None


def make_signature(telegram_id: Union[int, str], secret: str = DEFAULT_BOT_SECRET) -> str:
    """Створює 32-символьний HMAC-SHA256 підпис для конкретного Telegram ID."""
    uid = str(telegram_id).strip()
    return hmac.new(
        secret.encode("utf-8"),
        f"legit_bot_direct:{uid}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:32]


def create_miniapp_url(
    telegram_id: Union[int, str],
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    nickname: Optional[str] = None,
    balance_uah: Union[float, int, str] = 0.0,
    balance_gram: Union[float, int, str] = 0.0,
    locale: str = "uk",
    rate_gram_uah: Optional[float] = None,
    is_admin: bool = False,
    start_page: Optional[str] = None,
    orders: Optional[List[Dict[str, Any]]] = None,
    base_url: str = DEFAULT_MINIAPP_URL,
    secret: str = DEFAULT_BOT_SECRET,
    short_only: bool = False,
) -> str:
    """
    Генерує повне зашифроване посилання для переходу з Telegram-бота у MiniApp.

    Приклад результату:
    https://robin-jeep-pantomime.ngrok-free.dev/?k=1284525881.7f91eca3b4521298a5e62ecf1c264f53.<зашифрований_HEX_пакет>
    """
    uid = str(telegram_id).strip()
    if not uid.isdigit():
        raise ValueError(f"Некоректний telegram_id: {telegram_id}")

    sig32 = make_signature(uid, secret=secret)
    clean_base = (base_url or DEFAULT_MINIAPP_URL).rstrip("/")

    # Якщо потрібне тільки коротке посилання виду ?k=1284525881.7f91eca3b4521298a5e62ecf1c264f53
    if short_only:
        return f"{clean_base}/?k={uid}.{sig32}"

    clean_un = (username or "").lstrip("@").strip()[:64]
    clean_fn = (first_name or "").strip()[:64]
    clean_ln = (last_name or "").strip()[:64]
    full_name = " ".join(p for p in (clean_fn, clean_ln) if p).strip()
    display_nick = (nickname or full_name or (f"@{clean_un}" if clean_un else f"User {uid[-4:]}")).strip()[:64]

    try:
        uah_val = f"{max(0.0, float(balance_uah or 0.0)):.2f}"
    except (ValueError, TypeError):
        uah_val = "0.00"

    try:
        gram_val = f"{max(0.0, float(balance_gram or 0.0)):.9f}"
    except (ValueError, TypeError):
        gram_val = "0.000000000"

    payload: Dict[str, Any] = {
        "v": 2,
        "uid": uid,
        "un": clean_un or None,
        "fn": clean_fn or None,
        "ln": clean_ln or None,
        "nick": display_nick,
        "uah": uah_val,
        "gram": gram_val,
        "lc": locale if locale in ("uk", "ru", "en") else "uk",
        "vip": True,
        "admin": bool(is_admin),
        "start": start_page or None,
        "ts": int(time.time()),
    }

    if rate_gram_uah is not None and rate_gram_uah > 0:
        payload["rate"] = round(float(rate_gram_uah), 6)

    if orders:
        normalized_orders = []
        for o in orders[:15]:
            normalized_orders.append(
                {
                    "id": str(o.get("id", f"ord_{int(time.time())}")),
                    "title": str(o.get("title", "Замовлення"))[:120],
                    "total": f"{float(o.get('total', 0.0)):.2f}",
                    "currency": "GRAM" if str(o.get("currency")).upper() == "GRAM" else "UAH",
                    "status": str(o.get("status", "COMPLETED")),
                    "createdAt": str(o.get("createdAt", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))),
                    "quantity": int(o.get("quantity", 1)),
                }
            )
        payload["orders"] = normalized_orders

    # Прибираємо пусті ключі (None)
    compact_payload = {k: v for k, v in payload.items() if v is not None}
    json_str = json.dumps(compact_payload, ensure_ascii=False, separators=(",", ":"))
    encrypted_hex = encrypt_bot_payload_hex(json_str, uid, sig32)

    return f"{clean_base}/?k={uid}.{sig32}.{encrypted_hex}"


# ============================================================================
# 2. АВТОМАТИЧНЕ ЗЧИТУВАННЯ БАЛАНСІВ ІЗ БАЗИ ДАНИХ БОТА (SQLite)
# ============================================================================

def read_user_balances_from_sqlite(
    db_path: str,
    telegram_id: Union[int, str],
) -> Tuple[float, float]:
    """
    Універсальний рідер балансу користувача (UAH, GRAM) із SQLite бази бота.
    Автоматично перевіряє найпоширеніші назви таблиць і колонок у ботах.
    Повертає кортеж: (balance_uah, balance_gram).
    """
    if not db_path or not os.path.exists(db_path):
        return 0.0, 0.0

    uid_str = str(telegram_id).strip()
    try:
        conn = sqlite3.connect(db_path, timeout=3.0)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        # Перевіряємо таблицю users / accounts / profile
        for table in ("users", "user", "accounts", "clients", "profiles"):
            try:
                cur.execute(f"PRAGMA table_info({table})")
                cols = {row["name"].lower(): row["name"] for row in cur.fetchall()}
                if not cols:
                    continue

                id_col = (
                    cols.get("user_id")
                    or cols.get("telegram_id")
                    or cols.get("tg_id")
                    or cols.get("id")
                    or cols.get("uid")
                )
                if not id_col:
                    continue

                cur.execute(f"SELECT * FROM {table} WHERE {id_col} = ? LIMIT 1", (uid_str,))
                row = cur.fetchone()
                if not row:
                    continue

                row_dict = {k.lower(): row[k] for k in row.keys()}
                uah = float(
                    row_dict.get("balance_uah")
                    or row_dict.get("uah")
                    or row_dict.get("balance")
                    or row_dict.get("money")
                    or 0.0
                )
                gram = float(
                    row_dict.get("balance_gram")
                    or row_dict.get("gram")
                    or row_dict.get("crypto_balance")
                    or row_dict.get("ton_balance")
                    or 0.0
                )
                conn.close()
                return uah, gram
            except Exception:
                continue

        conn.close()
    except Exception:
        pass

    return 0.0, 0.0


# ============================================================================
# 3. ГОТОВІ ФУНКЦІЇ ДЛЯ AIOGRAM 3.x / AIOGRAM 2.x / TELEBOT
# ============================================================================

def build_url_for_telegram_user(
    tg_user: Any,
    balance_uah: Union[float, int, str] = 0.0,
    balance_gram: Union[float, int, str] = 0.0,
    db_path: Optional[str] = None,
    orders: Optional[List[Dict[str, Any]]] = None,
    base_url: str = DEFAULT_MINIAPP_URL,
    secret: str = DEFAULT_BOT_SECRET,
    is_admin: bool = False,
) -> str:
    """
    Приймає об'єкт \`message.from_user\` або \`callback_query.from_user\` (Aiogram / TeleBot / PTB),
    підтягує баланси (або з аргументів, або автоматично з \`db_path\`) і повертає готове довге посилання.
    """
    uid = getattr(tg_user, "id", None) or tg_user["id"]
    username = getattr(tg_user, "username", None)
    first_name = getattr(tg_user, "first_name", None)
    last_name = getattr(tg_user, "last_name", None)
    lang_code = (getattr(tg_user, "language_code", None) or "uk")[:2].lower()
    locale = lang_code if lang_code in ("uk", "ru", "en") else "uk"

    if db_path and float(balance_uah or 0) == 0.0 and float(balance_gram or 0) == 0.0:
        balance_uah, balance_gram = read_user_balances_from_sqlite(db_path, uid)

    return create_miniapp_url(
        telegram_id=uid,
        username=username,
        first_name=first_name,
        last_name=last_name,
        balance_uah=balance_uah,
        balance_gram=balance_gram,
        locale=locale,
        is_admin=is_admin,
        orders=orders,
        base_url=base_url,
        secret=secret,
    )


def get_aiogram_v3_markup(
    tg_user: Any,
    balance_uah: Union[float, int, str] = 0.0,
    balance_gram: Union[float, int, str] = 0.0,
    button_text: str = "🛍 Відкрити магазин (MiniApp)",
    use_webapp: bool = True,
    db_path: Optional[str] = None,
    base_url: str = DEFAULT_MINIAPP_URL,
    secret: str = DEFAULT_BOT_SECRET,
) -> Any:
    """
    Створює готову клавіатуру \`InlineKeyboardMarkup\` для Aiogram 3.x
    із вшитим зашифрованим посиланням користувача.
    """
    from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

    url = build_url_for_telegram_user(
        tg_user=tg_user,
        balance_uah=balance_uah,
        balance_gram=balance_gram,
        db_path=db_path,
        base_url=base_url,
        secret=secret,
    )
    if use_webapp:
        btn = InlineKeyboardButton(text=button_text, web_app=WebAppInfo(url=url))
    else:
        btn = InlineKeyboardButton(text=button_text, url=url)
    return InlineKeyboardMarkup(inline_keyboard=[[btn]])


def get_telebot_markup(
    tg_user: Any,
    balance_uah: Union[float, int, str] = 0.0,
    balance_gram: Union[float, int, str] = 0.0,
    button_text: str = "🛍 Відкрити магазин (MiniApp)",
    use_webapp: bool = True,
    db_path: Optional[str] = None,
    base_url: str = DEFAULT_MINIAPP_URL,
    secret: str = DEFAULT_BOT_SECRET,
) -> Any:
    """
    Створює готову клавіатуру \`InlineKeyboardMarkup\` для pyTelegramBotAPI (telebot).
    """
    from telebot.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

    url = build_url_for_telegram_user(
        tg_user=tg_user,
        balance_uah=balance_uah,
        balance_gram=balance_gram,
        db_path=db_path,
        base_url=base_url,
        secret=secret,
    )
    markup = InlineKeyboardMarkup()
    if use_webapp:
        markup.add(InlineKeyboardButton(text=button_text, web_app=WebAppInfo(url=url)))
    else:
        markup.add(InlineKeyboardButton(text=button_text, url=url))
    return markup


# ============================================================================
# 4. ПРИКЛАД ВИКОРИСТАННЯ ТА САМОПЕРЕВІРКА
# ============================================================================

if __name__ == "__main__":
    # 1. Короткий формат (як у твоєму прикладі):
    short_link = create_miniapp_url(
        telegram_id=1284525881,
        base_url="https://robin-jeep-pantomime.ngrok-free.dev",
        short_only=True,
    )
    print("1) Коротке посилання:")
    print(short_link)

    # 2. Повне довге зашифроване посилання з нікнеймом, юзернеймом, грн (₴) та GRAM:
    long_link = create_miniapp_url(
        telegram_id=1284525881,
        username="legit_vip",
        first_name="Striver",
        nickname="Legit VIP",
        balance_uah=1450.50,
        balance_gram=32.75,
        locale="uk",
        orders=[
            {
                "id": "ord_730101",
                "title": "CS2 Prime · 1,450 год",
                "total": "480.00",
                "currency": "UAH",
                "status": "COMPLETED",
            }
        ],
        base_url="https://robin-jeep-pantomime.ngrok-free.dev",
    )
    print("\n2) Довге зашифроване посилання (з балансами UAH та GRAM, нікнеймом і замовленнями):")
    print(long_link)

    # 3. Перевірка розшифровки:
    k_value = long_link.split("?k=", 1)[1]
    uid_part, sig_part, hex_part = k_value.split(".", 2)
    restored = decrypt_bot_payload_hex(hex_part, uid_part, sig_part)
    print("\n3) Розшифровані дані всередині MiniApp (0 мс на старті):")
    print(json.dumps(restored, ensure_ascii=False, indent=2))`;

const ROOT_PACKAGE_JSON = JSON.stringify({
  name: "legit-assets",
  version: "0.9.0",
  private: true,
  scripts: {
    dev: "node boot.mjs dev",
    build: "node boot.mjs build",
    start: "node boot.mjs start",
    unpack: "node boot.mjs unpack",
    pack: "node boot.mjs pack",
    "bot-link": "node boot.mjs bot-link"
  },
  type: "module",
  engines: {
    node: ">=22.18.0"
  }
}, null, 2) + '\n';

const ROOT_RAILWAY_JSON = JSON.stringify({
  $schema: "https://railway.com/railway.schema.json",
  build: {
    builder: "DOCKERFILE",
    dockerfilePath: "Dockerfile"
  },
  deploy: {
    healthcheckPath: "/api/health",
    healthcheckTimeout: 180,
    restartPolicyType: "ON_FAILURE",
    restartPolicyMaxRetries: 5
  }
}, null, 2) + '\n';

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const s = createNetServer()
      .once('error', () => resolve(false))
      .once('listening', () => s.once('close', () => resolve(true)).close())
      .listen(Number(port), '0.0.0.0');
  });
}

async function detectActiveTunnel() {
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(600) });
    if (res.ok) {
      const data = await res.json();
      const t = data.tunnels?.find(item => item.public_url?.startsWith('https://'));
      if (t?.public_url) return t.public_url;
    }
  } catch {}
  return null;
}

const root=fileURLToPath(new URL('.',import.meta.url));
export const runtime=join(root,'.runtime');
const secretNames=['DELIVERY_ENCRYPTION_KEY','INTERNAL_API_SECRET','CRON_SECRET'];
export async function unpack() {
  // Auto-generate consolidated root configs & Python bot helper module if not present
  try { await writeFile(join(root, 'package.json'), ROOT_PACKAGE_JSON, { flag: 'wx' }); } catch {}
  try { await writeFile(join(root, 'railway.json'), ROOT_RAILWAY_JSON, { flag: 'wx' }); } catch {}
  try { await writeFile(join(root, 'bot_link_module.py'), PYTHON_BOT_LINK_MODULE, { flag: 'wx' }); } catch {}

  const pack=JSON.parse(await readFile(join(root,'app.pack.json'),'utf8'));
  if(pack.version!==1 || !pack.files)throw Error('Invalid application bundle');
  const entries=Object.entries(pack.files);
  for(const [name,entry] of entries) {
    if(!name || name.includes('\\') || name.split('/').some(p=>!p || p==='..' || p==='.') || resolve(runtime,name)===runtime || !resolve(runtime,name).startsWith(runtime+'/'))throw Error('Invalid bundled path');
    if(typeof entry.content!=='string' || createHash('sha256').update(entry.content).digest('hex')!==entry.sha256)throw Error('Damaged application bundle: '+name);
  }
  for(const [name,entry] of entries) {
    const target=join(runtime,name);
    const existing=await readFile(target,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(existing!==null && existing!==entry.content)throw Error('Edited runtime file: '+name+'. Save changes with node boot.mjs pack.');
  }
  for(const [name,entry] of entries) {
    const target=join(runtime,name);await mkdir(dirname(target),{recursive:true});
    try{await writeFile(target,entry.content,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
  }

  // Extract embedded loading.mp4 from assets.pack.json directly into .runtime/public/loading.mp4
  try {
    await mkdir(join(runtime, 'public'), { recursive: true });
    const dst = join(runtime, 'public', 'loading.mp4');
    let copied = false;
    for (const name of ['loading.mp4', 'loading_120fps.mp4']) {
      const src = join(root, name);
      const s = await stat(src).catch(() => null);
      if (s && s.isFile()) {
        await copyFile(src, dst).catch(() => {});
        copied = true;
        break;
      }
    }
    if (!copied) {
      const assetsRaw = await readFile(join(runtime, 'assets.pack.json'), 'utf8').catch(() => null);
      if (assetsRaw) {
        const assetsObj = JSON.parse(assetsRaw);
        if (typeof assetsObj['loading.mp4'] === 'string' && assetsObj['loading.mp4'].length > 0) {
          const mp4Buf = Buffer.from(assetsObj['loading.mp4'], 'base64');
          await writeFile(dst, mp4Buf);
        }
      }
    }
  } catch {}

  // Extract project sources (migrations, prisma schema, app router, scripts) if project.pack.json is present
  try {
    const projFile = join(runtime, 'project.pack.json');
    const projData = await readFile(projFile, 'utf8').catch(() => null);
    if (projData) {
      const projPack = JSON.parse(projData);
      if (projPack.version === 1 && projPack.files) {
        for (const [pName, pEntry] of Object.entries(projPack.files)) {
          const pTarget = join(runtime, pName);
          await mkdir(dirname(pTarget), { recursive: true });
          const buf = Buffer.from(pEntry.content, pEntry.encoding || 'utf8');
          try { await writeFile(pTarget, buf, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        }
      }
    }
  } catch {}
  return entries.length;
}
export async function persistentEnvironment(source=process.env) {
  const env={...source};
  env.COMMERCE_MODE ||= "ecosystem";
  env.BOT_BRIDGE_URL ||= "http://127.0.0.1:8099";
  const railway=Boolean(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PUBLIC_DOMAIN);
  let volumePath = env.RAILWAY_VOLUME_MOUNT_PATH || env.DATA_DIR;
  if (!volumePath && railway) {
    const dataStat = await stat('/data').catch(() => null);
    if (dataStat && dataStat.isDirectory()) volumePath = '/data';
  }
  const folder=volumePath || join(runtime,'.data');
  env.DATA_DIR=folder;
  await mkdir(folder,{recursive:true});
  const path=join(folder,'miniapp-secrets.json');
  let saved;
  try{saved=JSON.parse(await readFile(path,'utf8'));}
  catch(e){if(e.code!=='ENOENT')throw Error('Cannot read saved secrets. Restore miniapp-secrets.json; do not delete or regenerate it.');}
  if(saved) {
    if(saved.version!==1 || !saved.secrets || secretNames.some(name=>typeof saved.secrets[name]!=='string'))throw Error('Invalid saved secrets. Restore the original file.');
    if(env.DELIVERY_ENCRYPTION_KEY && env.DELIVERY_ENCRYPTION_KEY!==saved.secrets.DELIVERY_ENCRYPTION_KEY)throw Error('DELIVERY_ENCRYPTION_KEY differs from the saved key. Restore the existing key before starting.');
    for(const name of secretNames)env[name] ||= saved.secrets[name];
  } else {
    let db=join(folder,'legit.sqlite');
    if(env.DATABASE_URL?.startsWith('file:'))db=fileURLToPath(env.DATABASE_URL);
    const existing=await stat(db).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(existing?.size && !env.DELIVERY_ENCRYPTION_KEY)throw Error('Existing database: supply its original DELIVERY_ENCRYPTION_KEY. Automatic key replacement is refused.');
    env.DELIVERY_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    env.INTERNAL_API_SECRET ||= randomBytes(32).toString('hex');
    env.CRON_SECRET ||= randomBytes(32).toString('hex');
    if(!/^[A-Za-z0-9+/]{43}=$/.test(env.DELIVERY_ENCRYPTION_KEY) || ['INTERNAL_API_SECRET','CRON_SECRET'].some(name=>env[name].length<32))throw Error('Invalid internal secret configuration.');
    const secrets=Object.fromEntries(secretNames.map(name=>[name,env[name]]));
    try{await writeFile(path,JSON.stringify({version:1,secrets})+'\n',{flag:'wx',mode:0o600});}
    catch(e){if(e.code==='EEXIST')return persistentEnvironment(source);throw e;}
  }
  env.BOT_TOKEN ||= "8891616517:AAF8MBrmxxFkPJ7etSzO7XjssQCJvhMPr3k";
  if (!env.NEXT_PUBLIC_SITE_URL && env.RAILWAY_PUBLIC_DOMAIN) {
    env.NEXT_PUBLIC_SITE_URL = `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  }
  if(!/^[A-Za-z0-9+/]{43}=$/.test(env.DELIVERY_ENCRYPTION_KEY) || ['INTERNAL_API_SECRET','CRON_SECRET'].some(name=>env[name].length<32))throw Error('Invalid internal secret configuration.');
  if(railway){env.AUTO_MIGRATE='true';env.START_COMMERCE_WORKER='true';}
  return env;
}
async function run(args,env=process.env) {
  const child=spawn(args[0],args.slice(1),{cwd:runtime,env,stdio:'inherit'});
  const term=()=>child.kill('SIGTERM');const interrupt=()=>child.kill('SIGINT');
  process.once('SIGTERM',term);process.once('SIGINT',interrupt);
  try {return await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>done(code??(signal?1:0)));});}
  finally{process.off('SIGTERM',term);process.off('SIGINT',interrupt);}
}
async function main() {
  const command=process.argv[2] || 'start';
  if(command==='bot-link') {
    const opt = (name, def = '') => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
    const uid = opt('uid', '1284525881');
    const un = opt('un', 'legit_user');
    const nick = opt('nick', 'Legit User');
    const uah = opt('uah', '1250.00');
    const gram = opt('gram', '25.500000000');
    const domain = opt('domain', 'https://robin-jeep-pantomime.ngrok-free.dev');
    const secret = opt('secret', process.env.BOT_BRIDGE_SECRET || 'legit_assets_bot_secret');
    const shortUrl = createBotDirectLink({ baseUrl: domain, secret, telegramId: uid, shortOnly: true });
    const fullUrl = createBotDirectLink({
      baseUrl: domain,
      secret,
      telegramId: uid,
      username: un,
      nickname: nick,
      balanceUAH: uah,
      balanceGRAM: gram,
    });
    console.log(JSON.stringify({ telegramId: uid, shortUrl, fullEncryptedUrl: fullUrl }, null, 2));
    return;
  }
  if(command==='connect') {
    const option=name=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3);
    const origin=name=>{const raw=option(name);let url;try{url=new URL(raw);}catch{throw Error('Pass --'+name+'=https://your-domain');}if(url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)throw Error('Use a public HTTPS origin for '+name);return url.origin;};
    const miniapp=origin('miniapp'),bot=origin('bot');
    if(miniapp===bot)throw Error('Use the separate public domain of each service.');
    const secrets={BOT_BRIDGE_SECRET:process.env.BOT_BRIDGE_SECRET || randomBytes(32).toString('hex')};
    if(Object.values(secrets).some(value=>!/^[A-Za-z0-9_-]{32,256}$/.test(value)))throw Error('Connection secrets must contain 32–256 URL-safe characters.');
    const ignore=join(root,'.gitignore');
    const ignored=await readFile(ignore,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    if(!ignored.split(/\r?\n/).some(line=>line==='connection/' || line==='/connection/'))await writeFile(ignore,'\nconnection/\n',{flag:'a'});
    const folder=join(root,'connection');await mkdir(folder,{recursive:true,mode:0o700});
    const common=Object.entries(secrets).map(([key,value])=>key+'='+value).join('\n');
    const targets=[['miniapp-connection.env','COMMERCE_MODE=ecosystem\nBOT_BRIDGE_URL='+bot+'\n'+common+'\n'],['bot-connection.env','MINIAPP_BASE_URL='+miniapp+'\n'+common+'\n']];
    for(const [name] of targets){const exists=await stat(join(folder,name)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(exists)throw Error('Existing connection files kept. Reuse them; do not generate different secrets.');}
    for(const [name,content] of targets)await writeFile(join(folder,name),content,{flag:'wx',mode:0o600});
    console.log('Created connection/miniapp-connection.env and connection/bot-connection.env. Add each to the matching service Variables; keep BOT_TOKEN identical. Secrets are not printed.');return;
  }
  if(command==='pack') {
    const path=join(root,'app.pack.json');
    const pack=JSON.parse(await readFile(path,'utf8'));
    for(const [name,entry] of Object.entries(pack.files)) {
      entry.content=await readFile(join(runtime,name),'utf8');entry.sha256=createHash('sha256').update(entry.content).digest('hex');
    }
    await writeFile(path,JSON.stringify(pack,null,2)+'\n');
    console.log('Application sources saved. For changes to generated routes/tests, run npm run source:pack in .runtime first.');
    return;
  }
  if(command==='unpack'){console.log('Application sources ready: '+await unpack()+' bundled files.');return;}
  // Runtime already exists in Docker; avoid rewriting source files on every restart.
  await stat(join(runtime,'package.json')).catch(async e=>{if(e.code==='ENOENT')await unpack();else throw e;});
  if(['start','dev'].includes(command) && (process.env.COMMERCE_MODE||'ecosystem')==='ecosystem') {
    let code='configured';let url;
    try{url=new URL(process.env.BOT_BRIDGE_URL || 'http://127.0.0.1:8099');}catch{code=process.env.BOT_BRIDGE_URL?'bridge_url_invalid':'bridge_url_missing';}
    if(url && (url.protocol!=='https:' && !(url.protocol==='http:' && (url.hostname==='127.0.0.1'||url.hostname==='localhost')) ||url.username||url.password||url.search||url.hash))code='bridge_url_invalid';
    if(code==='configured' && !/^[A-Za-z0-9_-]{32,256}$/.test(process.env.BOT_BRIDGE_SECRET||''))code='bridge_secret_invalid';
    if(url && process.env.RAILWAY_PUBLIC_DOMAIN && url.host===process.env.RAILWAY_PUBLIC_DOMAIN)code='bridge_self_reference';
    console.info(JSON.stringify({event:'bridge.configuration',status:code,hint:'Open /admin/operations for authenticated connection diagnostics. No provider connection has been verified by this startup message.'}));
  }
  if(command==='install')process.exitCode=await run(['npm','ci']);
  else if(command==='build') {
    const hasModules = await stat(join(runtime, 'node_modules')).catch(() => null);
    if (!hasModules) {
      await run(['npm', 'ci']);
    }
    const hasPrisma = await stat(join(runtime, 'node_modules/.prisma/client')).catch(() => null);
    if (!hasPrisma) {
      await run(['npx', 'prisma', 'generate']);
    }
    process.exitCode=await run(['npm','run','build']);
  }
  else if(command==='dev') {
    const env = await persistentEnvironment();
    const detected = await detectActiveTunnel();
    if (detected && !env.NEXT_PUBLIC_SITE_URL) {
      env.NEXT_PUBLIC_SITE_URL = detected;
      console.log(`[boot] Active tunnel detected: ${detected} -> configuring origin.`);
    }
    process.exitCode=await run(['npm','run','dev'], env);
  }
  else if(command==='start') {
    const env = await persistentEnvironment();
    const cliPort = process.argv.slice(3).find(a => /^\d+$/.test(a) || a.startsWith('--port='))?.replace('--port=', '');
    if (cliPort) {
      env.PORT = cliPort;
    } else if (!process.env.PORT) {
      const p3000Ok = await isPortAvailable(3000);
      if (!p3000Ok) {
        env.PORT = "3456";
        console.log('[boot] Port 3000 is occupied. Auto-selected port 3456.');
      } else {
        env.PORT = "3000";
      }
    }
    const detected = await detectActiveTunnel();
    if (detected && !env.NEXT_PUBLIC_SITE_URL) {
      env.NEXT_PUBLIC_SITE_URL = detected;
      console.log(`[boot] Active tunnel detected: ${detected} -> configuring origin.`);
    }
    env.BOT_BRIDGE_URL ||= "http://127.0.0.1:8099";
    const hasModules = await stat(join(runtime, 'node_modules')).catch(() => null);
    if (!hasModules) {
      await run(['npm', 'ci']);
    }
    process.exitCode = await run([process.execPath,'scripts/start.mjs'], env);
  }
  else if(command==='run')process.exitCode=await run(['npm','run',...process.argv.slice(3)],await persistentEnvironment());
  else throw Error('Use node boot.mjs unpack|install|build|dev|start|bot-link|run <npm script>|pack');
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
  console.error('[boot] '+(error.code?'File or process operation failed. Check Volume permissions and configuration.':error.message));process.exitCode=1;
});