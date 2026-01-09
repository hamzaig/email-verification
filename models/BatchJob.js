// models/BatchJob.js
const mongoose = require("mongoose");

const BatchJobSchema = new mongoose.Schema({
  batchId: {
    type: String,
    required: true,
    unique: true,
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  totalEmails: {
    type: Number,
    required: true,
  },
  processedEmails: {
    type: Number,
    default: 0,
  },
  validEmails: {
    type: Number,
    default: 0,
  },
  invalidEmails: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ["queued", "processing", "completed", "failed"],
    default: "queued",
  },
  callbackUrl: {
    type: String,
  },
  notifyEmail: {
    type: String,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  startedAt: {
    type: Date,
  },
  completedAt: {
    type: Date,
  },
  resultFile: {
    type: String,
  },
  error: {
    type: String,
  },
  jobId: {
    type: String,
  },
});

module.exports = mongoose.model("BatchJob", BatchJobSchema);
