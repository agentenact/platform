/**
 * The ready agents (agent templates), as the homepage and the /create builder show them. A mirror of
 * apps/api/src/builder/templates.ts: the ids, wording and each ready draft (the sentence, its values and the description
 * they are bound into). tests/templates.test.tsx fails on any drift, so the api stays the one source; the builder needs the
 * draft here to draw the sentence and the code view without a request. The draft flow still opens the api's own copy.
 */
import type { DraftData } from './draft-types';

export interface HostedTemplate {
  id: string;
  title: string;
  /** One line for a picker. */
  summary: string;
  draft: DraftData;
}

export const TEMPLATES: readonly HostedTemplate[] = [
  {
    id: "xlm-drop",
    title: "XLM buy-the-dip alert",
    summary: "Emails you when XLM dips sharply in an hour, a chance to buy.",
    draft: {
      "sentence": [
        "Every 5 minutes I look at XLM and email you when it is ",
        {
          "param": "drop"
        },
        "% or more cheaper than an hour ago, a chance to buy. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "drop",
          "label": "Dip",
          "kind": "number",
          "value": 5,
          "min": 1,
          "max": 50,
          "unit": "%"
        }
      ],
      "bindings": [
        {
          "param": "drop",
          "path": "/triggers/0/params/drop_pct"
        }
      ],
      "name": "XLM buy-the-dip alert",
      "spec": {
        "persona": "A calm Stellar watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "stellar_price_change",
              "args": {
                "symbol": "XLM",
                "window_s": 3600
              }
            },
            "code": "return !input.stale && input.changePct <= -params.drop_pct;",
            "params": {
              "drop_pct": 5
            },
            "every_s": 300,
            "cooldown_s": 3600,
            "mission": "XLM is sharply cheaper than an hour ago. Tell the owner briefly and calmly, as a chance to buy."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "wallet-watch",
    title: "Wallet watcher",
    summary: "Emails you when a wallet sends or receives money.",
    draft: {
      "sentence": [
        "Every 5 minutes I look at wallet ",
        {
          "param": "account"
        },
        " on ",
        {
          "param": "chain"
        },
        " and email you if it receives or sends money. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "account",
          "label": "Wallet",
          "kind": "text",
          "value": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        {
          "id": "chain",
          "label": "Network",
          "kind": "choice",
          "options": [
            {
              "label": "Stellar",
              "value": "stellar"
            },
            {
              "label": "Ethereum",
              "value": "ethereum"
            },
            {
              "label": "Base",
              "value": "base"
            },
            {
              "label": "Arbitrum",
              "value": "arbitrum"
            },
            {
              "label": "Polygon",
              "value": "polygon"
            },
            {
              "label": "Celo",
              "value": "celo"
            },
            {
              "label": "Solana",
              "value": "solana"
            },
            {
              "label": "Bitcoin",
              "value": "bitcoin"
            }
          ],
          "value": "stellar"
        }
      ],
      "bindings": [
        {
          "param": "account",
          "path": "/triggers/0/fetch/args/address"
        },
        {
          "param": "chain",
          "path": "/triggers/0/fetch/args/chain"
        }
      ],
      "name": "Account watcher",
      "spec": {
        "persona": "A calm wallet watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "wallet_payments",
              "args": {
                "chain": "stellar",
                "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "direction": "both",
                "since_s": 420,
                "limit": 10
              }
            },
            "code": "return input.payments.length > 0;",
            "every_s": 300,
            "cooldown_s": 420,
            "mission": "The watched account moved money. Say who paid whom and how much."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "big-usdc",
    title: "Big USDC moves",
    summary: "Emails you when a wallet moves a large amount of USDC.",
    draft: {
      "sentence": [
        "Every 5 minutes I look at wallet ",
        {
          "param": "account"
        },
        " on ",
        {
          "param": "chain"
        },
        " and email you if it moves ",
        {
          "param": "size"
        },
        " or more. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "account",
          "label": "Wallet",
          "kind": "text",
          "value": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        {
          "id": "chain",
          "label": "Network",
          "kind": "choice",
          "options": [
            {
              "label": "Stellar",
              "value": "stellar"
            },
            {
              "label": "Ethereum",
              "value": "ethereum"
            },
            {
              "label": "Base",
              "value": "base"
            },
            {
              "label": "Arbitrum",
              "value": "arbitrum"
            },
            {
              "label": "Polygon",
              "value": "polygon"
            },
            {
              "label": "Celo",
              "value": "celo"
            },
            {
              "label": "Solana",
              "value": "solana"
            },
            {
              "label": "Optimism",
              "value": "optimism"
            }
          ],
          "value": "stellar"
        },
        {
          "id": "size",
          "label": "Size",
          "kind": "choice",
          "options": [
            {
              "label": "1,000 USDC",
              "value": "1000"
            },
            {
              "label": "10,000 USDC",
              "value": "10000"
            },
            {
              "label": "100,000 USDC",
              "value": "100000"
            }
          ],
          "value": "10000"
        }
      ],
      "bindings": [
        {
          "param": "account",
          "path": "/triggers/0/fetch/args/address"
        },
        {
          "param": "chain",
          "path": "/triggers/0/fetch/args/chain"
        },
        {
          "param": "size",
          "path": "/triggers/0/fetch/args/min_amount"
        }
      ],
      "name": "Big USDC move",
      "spec": {
        "persona": "A calm wallet watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "wallet_payments",
              "args": {
                "chain": "stellar",
                "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "asset": "USDC",
                "min_amount": "10000",
                "direction": "both",
                "since_s": 420,
                "limit": 10
              }
            },
            "code": "return input.payments.length > 0;",
            "every_s": 300,
            "cooldown_s": 420,
            "mission": "A large USDC payment happened. Say who paid whom and how much."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "daily-digest",
    title: "Daily Stellar digest",
    summary: "Writes a short Stellar DeFi digest every day.",
    draft: {
      "sentence": [
        "Every ",
        {
          "param": "when"
        },
        " I write a short Stellar DeFi digest and email it to you."
      ],
      "params": [
        {
          "id": "when",
          "label": "When",
          "kind": "time",
          "presets": [
            {
              "label": "morning",
              "value": "0 8 * * *"
            },
            {
              "label": "evening",
              "value": "0 18 * * *"
            }
          ],
          "value": "0 8 * * *"
        }
      ],
      "bindings": [
        {
          "param": "when",
          "path": "/triggers/0/cron"
        }
      ],
      "name": "Daily Stellar digest",
      "spec": {
        "persona": "A calm Stellar watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "web_search",
          "web_read",
          "market_price",
          "send_email"
        ],
        "triggers": [
          {
            "kind": "cron",
            "cron": "0 8 * * *",
            "mission": "Write a short digest of what happened in Stellar DeFi in the last day and email it."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "coin-crash",
    title: "Bargain alert",
    summary: "Emails you when BTC, ETH, SOL or XLM gets much cheaper in a day.",
    draft: {
      "sentence": [
        "Every 15 minutes I look at ",
        {
          "param": "coin"
        },
        " and email you when it is ",
        {
          "param": "drop"
        },
        "% or more cheaper than a day ago, a chance to buy. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "coin",
          "label": "Coin",
          "kind": "choice",
          "options": [
            {
              "label": "BTC",
              "value": "BTC"
            },
            {
              "label": "ETH",
              "value": "ETH"
            },
            {
              "label": "SOL",
              "value": "SOL"
            },
            {
              "label": "XLM",
              "value": "XLM"
            }
          ],
          "value": "BTC"
        },
        {
          "id": "drop",
          "label": "Dip",
          "kind": "number",
          "value": 10,
          "min": 2,
          "max": 60,
          "unit": "%"
        }
      ],
      "bindings": [
        {
          "param": "coin",
          "path": "/triggers/0/fetch/args/symbol"
        },
        {
          "param": "drop",
          "path": "/triggers/0/params/drop_pct"
        }
      ],
      "name": "Bargain alert",
      "spec": {
        "persona": "A calm Stellar watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "stellar_price_change",
              "args": {
                "symbol": "BTC",
                "window_s": 86400
              }
            },
            "code": "return !input.stale && input.changePct <= -params.drop_pct;",
            "params": {
              "drop_pct": 10
            },
            "every_s": 900,
            "cooldown_s": 86400,
            "mission": "The coin is sharply cheaper than a day ago. Tell the owner briefly and calmly, as a chance to buy, with the price now and a day ago."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "coin-jump",
    title: "Price jump alert",
    summary: "Emails you when a coin rises sharply in an hour.",
    draft: {
      "sentence": [
        "Every 5 minutes I look at ",
        {
          "param": "coin"
        },
        " and email you if it rises ",
        {
          "param": "rise"
        },
        "% or more in an hour. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "coin",
          "label": "Coin",
          "kind": "choice",
          "options": [
            {
              "label": "BTC",
              "value": "BTC"
            },
            {
              "label": "ETH",
              "value": "ETH"
            },
            {
              "label": "SOL",
              "value": "SOL"
            },
            {
              "label": "XLM",
              "value": "XLM"
            }
          ],
          "value": "ETH"
        },
        {
          "id": "rise",
          "label": "Rise",
          "kind": "number",
          "value": 5,
          "min": 1,
          "max": 50,
          "unit": "%"
        }
      ],
      "bindings": [
        {
          "param": "coin",
          "path": "/triggers/0/fetch/args/symbol"
        },
        {
          "param": "rise",
          "path": "/triggers/0/params/rise_pct"
        }
      ],
      "name": "Price jump alert",
      "spec": {
        "persona": "A calm Stellar watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "stellar_price_change",
              "args": {
                "symbol": "ETH",
                "window_s": 3600
              }
            },
            "code": "return !input.stale && input.changePct >= params.rise_pct;",
            "params": {
              "rise_pct": 5
            },
            "every_s": 300,
            "cooldown_s": 3600,
            "mission": "The coin rose sharply in the last hour. Tell the owner briefly, with the price now and an hour ago."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "price-target",
    title: "XLM price target",
    summary: "Emails you once XLM reaches the price you pick.",
    draft: {
      "sentence": [
        "Every 5 minutes I check the XLM price and email you once it reaches $",
        {
          "param": "target"
        },
        ". Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "target",
          "label": "Target",
          "kind": "number",
          "value": 1,
          "min": 0.01,
          "max": 100
        }
      ],
      "bindings": [
        {
          "param": "target",
          "path": "/triggers/0/params/target"
        }
      ],
      "name": "XLM price target",
      "spec": {
        "persona": "A calm Stellar watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "stellar_price",
              "args": {
                "symbol": "XLM"
              }
            },
            "code": "return !input.stale && Number(input.usd) >= params.target;",
            "params": {
              "target": 1
            },
            "every_s": 300,
            "cooldown_s": 86400,
            "mission": "XLM reached the price the owner was waiting for. Tell them briefly, with the price now."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "usdc-peg",
    title: "USDC dollar check",
    summary: "Emails you if USDC stops holding a dollar.",
    draft: {
      "sentence": [
        "Every 5 minutes I check that USDC is worth a dollar and email you if it trades below $",
        {
          "param": "floor"
        },
        ". Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "floor",
          "label": "Floor",
          "kind": "number",
          "value": 0.99,
          "min": 0.5,
          "max": 0.999
        }
      ],
      "bindings": [
        {
          "param": "floor",
          "path": "/triggers/0/params/floor"
        }
      ],
      "name": "USDC dollar check",
      "spec": {
        "persona": "A calm Stellar watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "stellar_price",
              "args": {
                "symbol": "USDC"
              }
            },
            "code": "return !input.stale && Number(input.usd) < params.floor;",
            "params": {
              "floor": 0.99
            },
            "every_s": 300,
            "cooldown_s": 3600,
            "mission": "USDC is trading below a dollar. Tell the owner calmly, with the price now."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "payment-received",
    title: "Payment received",
    summary: "Emails you when money arrives in a wallet.",
    draft: {
      "sentence": [
        "Every 5 minutes I look at wallet ",
        {
          "param": "account"
        },
        " on ",
        {
          "param": "chain"
        },
        " and email you when money arrives. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "account",
          "label": "Wallet",
          "kind": "text",
          "value": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        {
          "id": "chain",
          "label": "Network",
          "kind": "choice",
          "options": [
            {
              "label": "Stellar",
              "value": "stellar"
            },
            {
              "label": "Ethereum",
              "value": "ethereum"
            },
            {
              "label": "Base",
              "value": "base"
            },
            {
              "label": "Arbitrum",
              "value": "arbitrum"
            },
            {
              "label": "Polygon",
              "value": "polygon"
            },
            {
              "label": "Celo",
              "value": "celo"
            },
            {
              "label": "Solana",
              "value": "solana"
            },
            {
              "label": "Bitcoin",
              "value": "bitcoin"
            }
          ],
          "value": "stellar"
        }
      ],
      "bindings": [
        {
          "param": "account",
          "path": "/triggers/0/fetch/args/address"
        },
        {
          "param": "chain",
          "path": "/triggers/0/fetch/args/chain"
        }
      ],
      "name": "Payment received",
      "spec": {
        "persona": "A calm wallet watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "wallet_payments",
              "args": {
                "chain": "stellar",
                "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "direction": "in",
                "since_s": 420,
                "limit": 10
              }
            },
            "code": "return input.payments.length > 0;",
            "every_s": 300,
            "cooldown_s": 420,
            "mission": "The wallet received money. Say who paid and how much."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "low-balance",
    title: "Top-up reminder",
    summary: "Reminds you to top up a wallet before its XLM runs low.",
    draft: {
      "sentence": [
        "Every hour I look at wallet ",
        {
          "param": "account"
        },
        " on ",
        {
          "param": "chain"
        },
        " and email you if it holds less than ",
        {
          "param": "min"
        },
        " of that network’s own coin. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "account",
          "label": "Wallet",
          "kind": "text",
          "value": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        {
          "id": "chain",
          "label": "Network",
          "kind": "choice",
          "options": [
            {
              "label": "Stellar",
              "value": "stellar"
            },
            {
              "label": "Ethereum",
              "value": "ethereum"
            },
            {
              "label": "Base",
              "value": "base"
            },
            {
              "label": "Arbitrum",
              "value": "arbitrum"
            },
            {
              "label": "Polygon",
              "value": "polygon"
            },
            {
              "label": "Celo",
              "value": "celo"
            },
            {
              "label": "Solana",
              "value": "solana"
            },
            {
              "label": "Bitcoin",
              "value": "bitcoin"
            }
          ],
          "value": "stellar"
        },
        {
          "id": "min",
          "label": "Minimum",
          "kind": "number",
          "value": 100,
          "min": 0.0001,
          "max": 1000000
        }
      ],
      "bindings": [
        {
          "param": "account",
          "path": "/triggers/0/fetch/args/address"
        },
        {
          "param": "chain",
          "path": "/triggers/0/fetch/args/chain"
        },
        {
          "param": "min",
          "path": "/triggers/0/params/min_balance"
        }
      ],
      "name": "Top-up reminder",
      "spec": {
        "persona": "A calm wallet watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "wallet_balance",
              "args": {
                "chain": "stellar",
                "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
              }
            },
            "code": "if (!input.exists) return false; const coin = input.balances[0]; return !!coin && Number(coin.amount) < params.min_balance;",
            "params": {
              "min_balance": 100
            },
            "every_s": 3600,
            "cooldown_s": 86400,
            "mission": "The wallet is running low on its network’s own coin. Tell the owner the balance now."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "money-out",
    title: "Spending tracker",
    summary: "Emails you each time a wallet sends money, so you always know where it went.",
    draft: {
      "sentence": [
        "Every 5 minutes I look at wallet ",
        {
          "param": "account"
        },
        " on ",
        {
          "param": "chain"
        },
        " and email you each time it sends money. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "account",
          "label": "Wallet",
          "kind": "text",
          "value": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        {
          "id": "chain",
          "label": "Network",
          "kind": "choice",
          "options": [
            {
              "label": "Stellar",
              "value": "stellar"
            },
            {
              "label": "Ethereum",
              "value": "ethereum"
            },
            {
              "label": "Base",
              "value": "base"
            },
            {
              "label": "Arbitrum",
              "value": "arbitrum"
            },
            {
              "label": "Polygon",
              "value": "polygon"
            },
            {
              "label": "Celo",
              "value": "celo"
            },
            {
              "label": "Solana",
              "value": "solana"
            },
            {
              "label": "Bitcoin",
              "value": "bitcoin"
            }
          ],
          "value": "stellar"
        }
      ],
      "bindings": [
        {
          "param": "account",
          "path": "/triggers/0/fetch/args/address"
        },
        {
          "param": "chain",
          "path": "/triggers/0/fetch/args/chain"
        }
      ],
      "name": "Spending tracker",
      "spec": {
        "persona": "A calm wallet watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "wallet_payments",
              "args": {
                "chain": "stellar",
                "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "direction": "out",
                "since_s": 420,
                "limit": 10
              }
            },
            "code": "return input.payments.length > 0;",
            "every_s": 300,
            "cooldown_s": 420,
            "mission": "The watched wallet sent money. Say where it went and how much, in one or two lines, so the owner can confirm it was them."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "low-usdc",
    title: "USDC top-up reminder",
    summary: "Reminds you to top up a wallet before its USDC runs low.",
    draft: {
      "sentence": [
        "Every hour I look at wallet ",
        {
          "param": "account"
        },
        " on ",
        {
          "param": "chain"
        },
        " and email you if it holds less than ",
        {
          "param": "min"
        },
        " USDC. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "account",
          "label": "Wallet",
          "kind": "text",
          "value": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        {
          "id": "chain",
          "label": "Network",
          "kind": "choice",
          "options": [
            {
              "label": "Stellar",
              "value": "stellar"
            },
            {
              "label": "Ethereum",
              "value": "ethereum"
            },
            {
              "label": "Base",
              "value": "base"
            },
            {
              "label": "Arbitrum",
              "value": "arbitrum"
            },
            {
              "label": "Polygon",
              "value": "polygon"
            },
            {
              "label": "Celo",
              "value": "celo"
            },
            {
              "label": "Solana",
              "value": "solana"
            },
            {
              "label": "Optimism",
              "value": "optimism"
            }
          ],
          "value": "stellar"
        },
        {
          "id": "min",
          "label": "Minimum",
          "kind": "number",
          "value": 100,
          "min": 1,
          "max": 1000000,
          "unit": "USDC"
        }
      ],
      "bindings": [
        {
          "param": "account",
          "path": "/triggers/0/fetch/args/address"
        },
        {
          "param": "chain",
          "path": "/triggers/0/fetch/args/chain"
        },
        {
          "param": "min",
          "path": "/triggers/0/params/min_usdc"
        }
      ],
      "name": "USDC top-up reminder",
      "spec": {
        "persona": "A calm wallet watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "wallet_balance",
              "args": {
                "chain": "stellar",
                "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
              }
            },
            "code": "if (!input.exists) return false; const usdc = input.balances.find((b) => b.symbol === 'USDC'); return (usdc ? Number(usdc.amount) : 0) < params.min_usdc;",
            "params": {
              "min_usdc": 100
            },
            "every_s": 3600,
            "cooldown_s": 86400,
            "mission": "It is time to top up the wallet’s USDC. Tell the owner how much USDC it holds now."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "big-usdt",
    title: "Big USDT moves",
    summary: "Emails you when a wallet moves a large amount of USDT.",
    draft: {
      "sentence": [
        "Every 5 minutes I look at wallet ",
        {
          "param": "account"
        },
        " on ",
        {
          "param": "chain"
        },
        " and email you if it moves ",
        {
          "param": "size"
        },
        " or more. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "account",
          "label": "Wallet",
          "kind": "text",
          "value": "0xabababababababababababababababababababab"
        },
        {
          "id": "chain",
          "label": "Network",
          "kind": "choice",
          "options": [
            {
              "label": "Ethereum",
              "value": "ethereum"
            },
            {
              "label": "Base",
              "value": "base"
            },
            {
              "label": "Arbitrum",
              "value": "arbitrum"
            },
            {
              "label": "Polygon",
              "value": "polygon"
            },
            {
              "label": "Celo",
              "value": "celo"
            },
            {
              "label": "Solana",
              "value": "solana"
            },
            {
              "label": "Optimism",
              "value": "optimism"
            }
          ],
          "value": "ethereum"
        },
        {
          "id": "size",
          "label": "Size",
          "kind": "choice",
          "options": [
            {
              "label": "1,000 USDT",
              "value": "1000"
            },
            {
              "label": "10,000 USDT",
              "value": "10000"
            },
            {
              "label": "100,000 USDT",
              "value": "100000"
            }
          ],
          "value": "10000"
        }
      ],
      "bindings": [
        {
          "param": "account",
          "path": "/triggers/0/fetch/args/address"
        },
        {
          "param": "chain",
          "path": "/triggers/0/fetch/args/chain"
        },
        {
          "param": "size",
          "path": "/triggers/0/fetch/args/min_amount"
        }
      ],
      "name": "Big USDT move",
      "spec": {
        "persona": "A calm wallet watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "wallet_payments",
              "args": {
                "chain": "ethereum",
                "address": "0xabababababababababababababababababababab",
                "asset": "USDT",
                "min_amount": "10000",
                "direction": "both",
                "since_s": 420,
                "limit": 10
              }
            },
            "code": "return input.payments.length > 0;",
            "every_s": 300,
            "cooldown_s": 420,
            "mission": "A large USDT payment happened. Say who paid whom and how much."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "daily-balance",
    title: "Daily balance",
    summary: "Emails you what a wallet holds, every day.",
    draft: {
      "sentence": [
        "Every day I look at wallet ",
        {
          "param": "account"
        },
        " on ",
        {
          "param": "chain"
        },
        " and email you what it holds."
      ],
      "params": [
        {
          "id": "account",
          "label": "Wallet",
          "kind": "text",
          "value": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        {
          "id": "chain",
          "label": "Network",
          "kind": "choice",
          "options": [
            {
              "label": "Stellar",
              "value": "stellar"
            },
            {
              "label": "Ethereum",
              "value": "ethereum"
            },
            {
              "label": "Base",
              "value": "base"
            },
            {
              "label": "Arbitrum",
              "value": "arbitrum"
            },
            {
              "label": "Polygon",
              "value": "polygon"
            },
            {
              "label": "Celo",
              "value": "celo"
            },
            {
              "label": "Solana",
              "value": "solana"
            },
            {
              "label": "Bitcoin",
              "value": "bitcoin"
            }
          ],
          "value": "stellar"
        }
      ],
      "bindings": [
        {
          "param": "account",
          "path": "/triggers/0/fetch/args/address"
        },
        {
          "param": "chain",
          "path": "/triggers/0/fetch/args/chain"
        }
      ],
      "name": "Daily balance",
      "spec": {
        "persona": "A calm wallet watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "wallet_balance",
              "args": {
                "chain": "stellar",
                "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
              }
            },
            "code": "return input.exists;",
            "every_s": 86400,
            "cooldown_s": 86400,
            "mission": "Email the owner a short note of what the wallet holds right now: the network’s own coin first, then any USDC or USDT."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "stablecoin-received",
    title: "Stablecoin received",
    summary: "Emails you when USDC or USDT arrives, on Ethereum, Base, Solana and more.",
    draft: {
      "sentence": [
        "Every 5 minutes I look at wallet ",
        {
          "param": "account"
        },
        " on ",
        {
          "param": "chain"
        },
        " and email you when ",
        {
          "param": "min"
        },
        " or more ",
        {
          "param": "coin"
        },
        " arrives. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "account",
          "label": "Wallet",
          "kind": "text",
          "value": "0xabababababababababababababababababababab"
        },
        {
          "id": "chain",
          "label": "Network",
          "kind": "choice",
          "options": [
            {
              "label": "Ethereum",
              "value": "ethereum"
            },
            {
              "label": "Base",
              "value": "base"
            },
            {
              "label": "Arbitrum",
              "value": "arbitrum"
            },
            {
              "label": "Polygon",
              "value": "polygon"
            },
            {
              "label": "Celo",
              "value": "celo"
            },
            {
              "label": "Solana",
              "value": "solana"
            },
            {
              "label": "Optimism",
              "value": "optimism"
            }
          ],
          "value": "base"
        },
        {
          "id": "coin",
          "label": "Coin",
          "kind": "choice",
          "options": [
            {
              "label": "USDC",
              "value": "USDC"
            },
            {
              "label": "USDT",
              "value": "USDT"
            }
          ],
          "value": "USDC"
        },
        {
          "id": "min",
          "label": "Minimum",
          "kind": "choice",
          "options": [
            {
              "label": "1",
              "value": "1"
            },
            {
              "label": "100",
              "value": "100"
            },
            {
              "label": "1,000",
              "value": "1000"
            },
            {
              "label": "10,000",
              "value": "10000"
            }
          ],
          "value": "100"
        }
      ],
      "bindings": [
        {
          "param": "account",
          "path": "/triggers/0/fetch/args/address"
        },
        {
          "param": "chain",
          "path": "/triggers/0/fetch/args/chain"
        },
        {
          "param": "coin",
          "path": "/triggers/0/fetch/args/asset"
        },
        {
          "param": "min",
          "path": "/triggers/0/fetch/args/min_amount"
        }
      ],
      "name": "Stablecoin received",
      "spec": {
        "persona": "A calm wallet watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "wallet_payments",
              "args": {
                "chain": "base",
                "address": "0xabababababababababababababababababababab",
                "asset": "USDC",
                "min_amount": "100",
                "direction": "in",
                "since_s": 420,
                "limit": 10
              }
            },
            "code": "return input.payments.length > 0;",
            "every_s": 300,
            "cooldown_s": 420,
            "mission": "The wallet received a stablecoin payment. Say who paid, how much and on which network."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "btc-received",
    title: "Bitcoin payment confirmed",
    summary: "Emails you once a Bitcoin payment to you is confirmed.",
    draft: {
      "sentence": [
        "Every 10 minutes I look at address ",
        {
          "param": "account"
        },
        " on ",
        {
          "param": "chain"
        },
        " and email you once a payment of ",
        {
          "param": "min"
        },
        " or more is confirmed in a block. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "account",
          "label": "Wallet",
          "kind": "text",
          "value": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
        },
        {
          "id": "chain",
          "label": "Network",
          "kind": "choice",
          "options": [
            {
              "label": "Bitcoin",
              "value": "bitcoin"
            },
            {
              "label": "Bitcoin testnet4",
              "value": "bitcoin-testnet4"
            }
          ],
          "value": "bitcoin"
        },
        {
          "id": "min",
          "label": "Minimum",
          "kind": "choice",
          "options": [
            {
              "label": "0.0001 BTC",
              "value": "0.0001"
            },
            {
              "label": "0.001 BTC",
              "value": "0.001"
            },
            {
              "label": "0.01 BTC",
              "value": "0.01"
            },
            {
              "label": "0.1 BTC",
              "value": "0.1"
            },
            {
              "label": "1 BTC",
              "value": "1"
            }
          ],
          "value": "0.001"
        }
      ],
      "bindings": [
        {
          "param": "account",
          "path": "/triggers/0/fetch/args/address"
        },
        {
          "param": "chain",
          "path": "/triggers/0/fetch/args/chain"
        },
        {
          "param": "min",
          "path": "/triggers/0/fetch/args/min_amount"
        }
      ],
      "name": "Bitcoin payment confirmed",
      "spec": {
        "persona": "A calm wallet watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "wallet_payments",
              "args": {
                "chain": "bitcoin",
                "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
                "asset": "native",
                "min_amount": "0.001",
                "direction": "in",
                "since_s": 3600,
                "limit": 10
              }
            },
            "code": "return input.payments.length > 0;",
            "every_s": 600,
            "cooldown_s": 3600,
            "mission": "A Bitcoin payment to the address is confirmed. Say how much arrived and from where."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "quiet-wallet",
    title: "Daily sales check-in",
    summary: "Checks a wallet gets paid every day and lets you know on a day it does not.",
    draft: {
      "sentence": [
        "Every 6 hours I look at wallet ",
        {
          "param": "account"
        },
        " on ",
        {
          "param": "chain"
        },
        " and email you if nothing has arrived in the last day. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "account",
          "label": "Wallet",
          "kind": "text",
          "value": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        },
        {
          "id": "chain",
          "label": "Network",
          "kind": "choice",
          "options": [
            {
              "label": "Stellar",
              "value": "stellar"
            },
            {
              "label": "Solana",
              "value": "solana"
            },
            {
              "label": "Bitcoin",
              "value": "bitcoin"
            }
          ],
          "value": "stellar"
        }
      ],
      "bindings": [
        {
          "param": "account",
          "path": "/triggers/0/fetch/args/address"
        },
        {
          "param": "chain",
          "path": "/triggers/0/fetch/args/chain"
        }
      ],
      "name": "Daily sales check-in",
      "spec": {
        "persona": "A calm wallet watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "wallet_payments",
              "args": {
                "chain": "stellar",
                "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "direction": "in",
                "since_s": 86400,
                "limit": 1
              }
            },
            "code": "return input.payments.length === 0;",
            "every_s": 21600,
            "cooldown_s": 86400,
            "mission": "No payment has arrived in the wallet for a whole day. Tell the owner calmly, in one or two lines."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "stablecoin-peg",
    title: "Dollar coins check",
    summary: "Emails you if USDT, DAI or another dollar coin stops holding a dollar.",
    draft: {
      "sentence": [
        "Every 5 minutes I check that USDT, DAI, USDe, PYUSD and FDUSD are each worth a dollar and email you if one trades below $",
        {
          "param": "floor"
        },
        ". Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "floor",
          "label": "Floor",
          "kind": "number",
          "value": 0.99,
          "min": 0.5,
          "max": 0.999
        }
      ],
      "bindings": [
        {
          "param": "floor",
          "path": "/triggers/0/params/floor"
        }
      ],
      "name": "Dollar coins check",
      "spec": {
        "persona": "A calm market watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "market_price",
              "args": {
                "ids": [
                  "tether",
                  "dai",
                  "ethena-usde",
                  "paypal-usd",
                  "first-digital-usd"
                ]
              }
            },
            "code": "return Object.values(input.prices).some((p) => typeof p === 'number' && p < params.floor);",
            "params": {
              "floor": 0.99
            },
            "every_s": 300,
            "cooldown_s": 3600,
            "mission": "A dollar coin is trading below a dollar. Tell the owner calmly which one, with its price now."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "morning-prices",
    title: "Morning prices",
    summary: "Emails you XLM, BTC and ETH prices every day.",
    draft: {
      "sentence": [
        "Every ",
        {
          "param": "when"
        },
        " I email you the prices of XLM, BTC and ETH and how much each moved in the last day."
      ],
      "params": [
        {
          "id": "when",
          "label": "When",
          "kind": "time",
          "presets": [
            {
              "label": "morning",
              "value": "0 7 * * *"
            },
            {
              "label": "evening",
              "value": "0 19 * * *"
            }
          ],
          "value": "0 7 * * *"
        }
      ],
      "bindings": [
        {
          "param": "when",
          "path": "/triggers/0/cron"
        }
      ],
      "name": "Morning prices",
      "spec": {
        "persona": "A calm Stellar watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "stellar_price",
          "stellar_price_change",
          "send_email"
        ],
        "triggers": [
          {
            "kind": "cron",
            "cron": "0 7 * * *",
            "mission": "Read the prices of XLM, BTC and ETH and their change over the last day, then email a short note with all three."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "weekly-recap",
    title: "Weekly crypto recap",
    summary: "Writes a short recap of the crypto week.",
    draft: {
      "sentence": [
        "Every ",
        {
          "param": "when"
        },
        " I write a short recap of the crypto week and email it to you."
      ],
      "params": [
        {
          "id": "when",
          "label": "When",
          "kind": "time",
          "presets": [
            {
              "label": "Monday morning",
              "value": "0 8 * * 1"
            },
            {
              "label": "Friday evening",
              "value": "0 18 * * 5"
            }
          ],
          "value": "0 8 * * 1"
        }
      ],
      "bindings": [
        {
          "param": "when",
          "path": "/triggers/0/cron"
        }
      ],
      "name": "Weekly crypto recap",
      "spec": {
        "persona": "A calm Stellar watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "web_search",
          "web_read",
          "market_price",
          "send_email"
        ],
        "triggers": [
          {
            "kind": "cron",
            "cron": "0 8 * * 1",
            "mission": "Write a short recap of the past week in crypto: the biggest price moves and the news behind them. Email it."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "btc-range",
    title: "BTC range alert",
    summary: "Emails you when BTC leaves the price range you set.",
    draft: {
      "sentence": [
        "Every 5 minutes I check the BTC price and email you if it goes below $",
        {
          "param": "low"
        },
        " or above $",
        {
          "param": "high"
        },
        ". Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "low",
          "label": "Below",
          "kind": "number",
          "value": 75000,
          "min": 1,
          "max": 1000000
        },
        {
          "id": "high",
          "label": "Above",
          "kind": "number",
          "value": 90000,
          "min": 1,
          "max": 1000000
        }
      ],
      "bindings": [
        {
          "param": "low",
          "path": "/triggers/0/params/low"
        },
        {
          "param": "high",
          "path": "/triggers/0/params/high"
        }
      ],
      "name": "BTC range alert",
      "spec": {
        "persona": "A calm Stellar watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "stellar_price",
              "args": {
                "symbol": "BTC"
              }
            },
            "code": "if (input.stale) return false; const usd = Number(input.usd); return usd < Math.min(params.low, params.high) || usd > Math.max(params.low, params.high);",
            "params": {
              "low": 75000,
              "high": 90000
            },
            "every_s": 300,
            "cooldown_s": 21600,
            "mission": "BTC left the price range the owner set. Tell them briefly which way it broke, with the price now."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "big-move",
    title: "Big move alert",
    summary: "Emails you when a coin moves sharply in an hour, up or down.",
    draft: {
      "sentence": [
        "Every 5 minutes I look at ",
        {
          "param": "coin"
        },
        " and email you if it moves ",
        {
          "param": "move"
        },
        "% or more in an hour, up or down. Otherwise I stay quiet and spend nothing."
      ],
      "params": [
        {
          "id": "coin",
          "label": "Coin",
          "kind": "choice",
          "options": [
            {
              "label": "BTC",
              "value": "BTC"
            },
            {
              "label": "ETH",
              "value": "ETH"
            },
            {
              "label": "SOL",
              "value": "SOL"
            },
            {
              "label": "XLM",
              "value": "XLM"
            }
          ],
          "value": "SOL"
        },
        {
          "id": "move",
          "label": "Move",
          "kind": "number",
          "value": 4,
          "min": 1,
          "max": 50,
          "unit": "%"
        }
      ],
      "bindings": [
        {
          "param": "coin",
          "path": "/triggers/0/fetch/args/symbol"
        },
        {
          "param": "move",
          "path": "/triggers/0/params/move_pct"
        }
      ],
      "name": "Big move alert",
      "spec": {
        "persona": "A calm Stellar watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "send_email"
        ],
        "triggers": [
          {
            "kind": "condition",
            "fetch": {
              "tool": "stellar_price_change",
              "args": {
                "symbol": "SOL",
                "window_s": 3600
              }
            },
            "code": "return !input.stale && Math.abs(input.changePct) >= params.move_pct;",
            "params": {
              "move_pct": 4
            },
            "every_s": 300,
            "cooldown_s": 3600,
            "mission": "The coin moved sharply in the last hour. Tell the owner briefly which way, with the price now and an hour ago."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "market-morning",
    title: "Market morning",
    summary: "Emails you prices and the day’s top crypto headline.",
    draft: {
      "sentence": [
        "Every ",
        {
          "param": "when"
        },
        " I email you the prices of BTC, ETH and XLM with the one crypto headline that matters most that day."
      ],
      "params": [
        {
          "id": "when",
          "label": "When",
          "kind": "time",
          "presets": [
            {
              "label": "morning",
              "value": "0 7 * * *"
            },
            {
              "label": "evening",
              "value": "0 19 * * *"
            }
          ],
          "value": "0 7 * * *"
        }
      ],
      "bindings": [
        {
          "param": "when",
          "path": "/triggers/0/cron"
        }
      ],
      "name": "Market morning",
      "spec": {
        "persona": "A calm Stellar watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "stellar_price",
          "stellar_price_change",
          "web_search",
          "web_read",
          "send_email"
        ],
        "triggers": [
          {
            "kind": "cron",
            "cron": "0 7 * * *",
            "mission": "Read the prices of BTC, ETH and XLM and their change over the last day. Find the single most important crypto headline of the last day, with its source link. Email a short note: the three prices, then the headline in two sentences."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
  {
    id: "agent-economy",
    title: "Agent economy weekly",
    summary: "Writes a weekly brief on AI agents that pay and get paid.",
    draft: {
      "sentence": [
        "Every ",
        {
          "param": "when"
        },
        " I read the week’s news on AI agents that pay and get paid, and email you a short brief."
      ],
      "params": [
        {
          "id": "when",
          "label": "When",
          "kind": "time",
          "presets": [
            {
              "label": "Monday morning",
              "value": "0 8 * * 1"
            },
            {
              "label": "Friday evening",
              "value": "0 18 * * 5"
            }
          ],
          "value": "0 8 * * 1"
        }
      ],
      "bindings": [
        {
          "param": "when",
          "path": "/triggers/0/cron"
        }
      ],
      "name": "Agent economy weekly",
      "spec": {
        "persona": "A calm Stellar watcher.",
        "system_prompt": "Watch and report in plain words.",
        "suggested_plan": [],
        "tools": [
          "web_search",
          "web_read",
          "send_email"
        ],
        "triggers": [
          {
            "kind": "cron",
            "cron": "0 8 * * 1",
            "mission": "Write a short brief of the past week in the agent economy: AI agents paying and getting paid (x402, Stellar and other agent payments), on-chain agent identity (ERC-8004) and notable launches. Five items at most, each with its source link. Email it."
          }
        ],
        "skills": [],
        "services": [],
        "delivery": {
          "email": true
        },
        "hire_targets": []
      }
    },
  },
];

/** The template with this id, if the api lists one. */
export const findTemplate = (id: string | undefined): HostedTemplate | undefined => TEMPLATES.find((t) => t.id === id);
