const mongoose = require("mongoose");

const UsageSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  month: {
    type: Number,
    required: true,
  },
  year: {
    type: Number,
    required: true,
  },
  count: {
    type: Number,
    default: 0,
  },
  lastUpdated: {
    type: Date,
    default: Date.now,
  },
});

// Compound index to ensure one record per user per month
UsageSchema.index({ user: 1, month: 1, year: 1 }, { unique: true });

module.exports = mongoose.model("Usage", UsageSchema);
