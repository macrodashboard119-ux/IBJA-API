const { RateLimiterMemory } = require("rate-limiter-flexible");

// --- Configuration ---
// General: 100 requests / 15 mins = 100 points / 900 seconds
const generalLimiter = new RateLimiterMemory({
  points: 100,
  duration: 15 * 60, // 15 minutes in seconds
  blockDuration: 15 * 60, // Block for 15 minutes if consumed points > points
});

// Data-Heavy: 20 requests / 15 mins = 20 points / 900 seconds
const dataHeavyLimiter = new RateLimiterMemory({
  points: 20,
  duration: 15 * 60,
  blockDuration: 15 * 60,
});

// Utility: 50 requests / 15 mins = 50 points / 900 seconds
const utilityLimiter = new RateLimiterMemory({
  points: 50,
  duration: 15 * 60,
  blockDuration: 15 * 60,
});

// --- Middleware Function ---
// (limiter) => (handler) => (req, res) 형태로 3단 커링.
// history.js/chart.js가 applyRateLimit(limiter)(handler)로 호출하기 때문에,
// 이 구조여야 실제 (req, res)가 handler 자리가 아니라 진짜 req/res로 전달됨.
// 예전 버전은 (limiter) => (req, res, next)였는데, applyRateLimit(limiter)(handler)로
// 호출하면 handler 자체가 req 자리에 즉시 바인딩되어버려서, module.exports가
// 함수가 아니라 이미 실행된(그리고 실패한) Promise가 되어버리는 버그가 있었음.
const rateLimiterMiddleware = (limiter) => (handler) => async (req, res) => {
  // Get the IP address - Vercel uses 'x-forwarded-for'
  const headers = req.headers || {};
  const forwarded = headers["x-forwarded-for"];
  const ip = forwarded ? forwarded.split(/, /)[0] : req.socket?.remoteAddress;

  if (!ip) {
    // Should ideally not happen, but handle defensively
    if (!res || typeof res.status !== "function") {
      console.error("Response object is invalid in rate limiter");
      return;
    }
    return res.status(400).json({ error: "Could not identify client IP" });
  }

  try {
    const rateLimiterRes = await limiter.consume(ip);

    // Set Headers on Success
    res.setHeader("X-RateLimit-Limit", limiter.points);
    res.setHeader("X-RateLimit-Remaining", rateLimiterRes.remainingPoints);
    // Calculate reset time (convert ms to Unix timestamp seconds)
    const resetTime = Math.ceil(
      (Date.now() + rateLimiterRes.msBeforeNext) / 1000
    );
    res.setHeader("X-RateLimit-Reset", resetTime);

    // Proceed to the actual API logic
    return handler(req, res);
  } catch (rejRes) {
    // Rate limit exceeded
    const retryAfter = Math.ceil(rejRes.msBeforeNext / 1000); // Seconds to wait
    const resetTime = new Date(Date.now() + rejRes.msBeforeNext).toISOString();

    res.setHeader("Retry-After", retryAfter);
    res.setHeader("X-RateLimit-Limit", limiter.points);
    res.setHeader("X-RateLimit-Remaining", 0);
    res.setHeader(
      "X-RateLimit-Reset",
      Math.ceil((Date.now() + rejRes.msBeforeNext) / 1000)
    );

    return res.status(429).json({
      error: "Rate limit exceeded",
      message: "Too many requests. Please try again later.",
      retryAfter: retryAfter,
      limit: limiter.points,
      remaining: 0,
      resetTime: resetTime,
    });
  }
};

module.exports = {
  generalLimiter,
  dataHeavyLimiter,
  utilityLimiter,
  applyRateLimit: rateLimiterMiddleware, // Export the middleware generator
};
