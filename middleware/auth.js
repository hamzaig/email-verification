const jwt = require("jsonwebtoken");
const User = require("../models/User");

module.exports = async function (req, res, next) {
  // Get token from header or query param for API access
  const token = req.header("x-auth-token");
  const apiKey = req.header("x-api-key") || req.query.apiKey;

  // Check if no token or API key
  if (!token && !apiKey) {
    return res.status(401).json({
      success: false,
      message: "No authentication token or API key, authorization denied",
    });
  }

  try {
    if (token) {
      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded.user;
      next();
    } else if (apiKey) {
      // Verify API key
      const user = await User.findOne({ apiKey });
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Invalid API key",
        });
      }

      req.user = {
        id: user.id,
      };
      next();
    }
  } catch (error) {
    console.error("Auth error:", error);
    res.status(401).json({
      success: false,
      message: "Token or API key is not valid",
    });
  }
};
