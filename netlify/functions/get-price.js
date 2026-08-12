// netlify/functions/get-price.js
//
// Returns the current SAFE/USD price using DexScreener's public API.
// Used by the storefront to compute how much SAFE a buyer must send
// for a given USD-priced product.

const TOKEN_MINT = "2BhAe4vwnDeBsWc67HSZ4cozq5qJsG3SYnFkZQwZnray";
const DEXSCREENER_URL = `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`;

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  try {
    const res = await fetch(DEXSCREENER_URL);
    if (!res.ok) {
      throw new Error(`DexScreener responded with status ${res.status}`);
    }
    const data = await res.json();

    if (!data.pairs || data.pairs.length === 0) {
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({
          error: "SAFE is not yet indexed on DexScreener. Try again shortly.",
        }),
      };
    }

    // Prefer the pair with the highest liquidity, in case multiple pools exist.
    const bestPair = data.pairs.reduce((best, pair) => {
      const liquidity = pair.liquidity && pair.liquidity.usd ? pair.liquidity.usd : 0;
      const bestLiquidity = best && best.liquidity && best.liquidity.usd ? best.liquidity.usd : -1;
      return liquidity > bestLiquidity ? pair : best;
    }, null);

    const priceUsd = parseFloat(bestPair.priceUsd);

    if (!priceUsd || Number.isNaN(priceUsd)) {
      throw new Error("Could not parse a valid SAFE/USD price from DexScreener");
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        mint: TOKEN_MINT,
        priceUsd,
        pairAddress: bestPair.pairAddress,
        dexId: bestPair.dexId,
        updatedAt: new Date().toISOString(),
      }),
    };
  } catch (err) {
    console.error("get-price error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to fetch SAFE price." }),
    };
  }
};
