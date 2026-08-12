// netlify/functions/verify-payment.js
//
// Verifies an on-chain SAFE token payment against a Solana transaction
// signature, then issues a short-lived pre-signed S3 URL for the
// purchased product's download.

const { Connection, PublicKey } = require("@solana/web3.js");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const products = require("../../products.json");
const downloads = require("./_downloads.json");

const TOKEN_MINT = "2BhAe4vwnDeBsWc67HSZ4cozq5qJsG3SYnFkZQwZnray";
const TOKEN_DECIMALS = 6;

// Allow the buyer to have paid slightly less than the exact live-quote
// amount to account for price movement between quote and confirmation.
const PRICE_TOLERANCE = 0.03; // 3%

const DEXSCREENER_URL = `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`;

async function getSafeUsdPrice() {
  const res = await fetch(DEXSCREENER_URL);
  if (!res.ok) throw new Error("Failed to fetch SAFE price for verification");
  const data = await res.json();
  if (!data.pairs || data.pairs.length === 0) {
    throw new Error("SAFE price unavailable (not indexed on DexScreener)");
  }
  const bestPair = data.pairs.reduce((best, pair) => {
    const liquidity = pair.liquidity?.usd ?? 0;
    const bestLiquidity = best?.liquidity?.usd ?? -1;
    return liquidity > bestLiquidity ? pair : best;
  }, null);
  return parseFloat(bestPair.priceUsd);
}

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const { signature, productId, buyerWallet } = JSON.parse(event.body || "{}");

    if (!signature || !productId || !buyerWallet) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing signature, productId, or buyerWallet" }),
      };
    }

    const product = products.find((p) => p.id === productId);
    if (!product) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Unknown product" }) };
    }

    const downloadKey = downloads[productId];
    if (!downloadKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "No download configured for this product" }),
      };
    }

    const receiverWallet = process.env.RECEIVER_WALLET;
    const rpcUrl = process.env.SOLANA_RPC_URL;
    if (!receiverWallet || !rpcUrl) {
      throw new Error("Server misconfiguration: missing RECEIVER_WALLET or SOLANA_RPC_URL");
    }

    const connection = new Connection(rpcUrl, "confirmed");

    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (!tx) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Transaction not found or not yet confirmed" }),
      };
    }

    if (tx.meta?.err) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Transaction failed on-chain" }),
      };
    }

    // Compute the SAFE token amount received by RECEIVER_WALLET by diffing
    // pre/post token balances for the receiver's associated token account.
    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];

    const receiverPost = postBalances.find(
      (b) => b.owner === receiverWallet && b.mint === TOKEN_MINT
    );
    const receiverPre = preBalances.find(
      (b) => b.owner === receiverWallet && b.mint === TOKEN_MINT
    );

    if (!receiverPost) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "No SAFE transfer to the receiver wallet found in this transaction" }),
      };
    }

    const preAmount = receiverPre ? Number(receiverPre.uiTokenAmount.amount) : 0;
    const postAmount = Number(receiverPost.uiTokenAmount.amount);
    const receivedRaw = postAmount - preAmount;
    const receivedSafe = receivedRaw / 10 ** TOKEN_DECIMALS;

    if (receivedSafe <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "No positive SAFE amount transferred to receiver" }),
      };
    }

    // Confirm the buyer's wallet is a signer/source of this transaction.
    const accountKeys = tx.transaction.message.accountKeys.map((k) =>
      typeof k === "string" ? k : k.pubkey.toBase58()
    );
    if (!accountKeys.includes(buyerWallet)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Buyer wallet not found as a participant in this transaction" }),
      };
    }

    // Verify the amount received covers the product price at the live rate.
    const safeUsdPrice = await getSafeUsdPrice();
    const requiredSafe = product.priceUSD / safeUsdPrice;
    const minAcceptable = requiredSafe * (1 - PRICE_TOLERANCE);

    if (receivedSafe < minAcceptable) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Payment amount is below the required price",
          required: requiredSafe,
          received: receivedSafe,
        }),
      };
    }

    // Payment verified — generate a short-lived pre-signed S3 download URL.
    const s3 = new S3Client({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: downloadKey,
    });

    const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 900 }); // 15 minutes

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        product: product.id,
        receivedSafe,
        downloadUrl,
        expiresIn: 900,
      }),
    };
  } catch (err) {
    console.error("verify-payment error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Internal error verifying payment" }),
    };
  }
};
