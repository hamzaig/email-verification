# 📧 Email Verification API

A production-ready, enterprise-grade REST API for email verification and enrichment. Built with Node.js, Express, and MongoDB, this API provides comprehensive email validation including syntax checking, MX record verification, SMTP validation, disposable email detection, and more.

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Express](https://img.shields.io/badge/express-4.18.2-lightgrey)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/mongodb-7.0.3-green)](https://www.mongodb.com/)

## ✨ Features

### Core Functionality
- ✅ **Email Verification** - Comprehensive email validation with multiple checks
- 🔍 **Email Enrichment** - Extract additional information from email addresses
- 📦 **Bulk Verification** - Process multiple emails efficiently using queue system
- 🚀 **Async Processing** - Background job processing with Bull queues
- 💾 **Result Caching** - Redis-based caching for improved performance
- 📊 **Usage Tracking** - Monitor API usage and limits per user

### Verification Checks
- **Syntax Validation** - RFC-compliant email format checking
- **MX Record Verification** - Domain mail server validation
- **SMTP Verification** - Real-time mailbox existence checking
- **Disposable Email Detection** - Identify temporary email addresses
- **Role Account Detection** - Detect generic email addresses (admin@, info@, etc.)
- **Catch-All Detection** - Identify catch-all domains
- **Domain Typo Detection** - Suggest corrections for common typos
- **Spam Trap Detection** - Identify potential spam trap addresses

### Security & Performance
- 🔐 **JWT Authentication** - Secure token-based authentication
- 🔑 **API Key Support** - Alternative authentication method
- 🛡️ **Rate Limiting** - Protect against abuse
- 🚦 **Request Throttling** - Prevent server overload
- 🔒 **Helmet.js** - Security headers protection
- 📝 **Request Sanitization** - XSS and injection protection
- 📈 **Monitoring & Logging** - Sentry integration and Winston logging
- 📊 **Prometheus Metrics** - Performance monitoring

### Additional Features
- 💳 **Stripe Integration** - Subscription and billing management
- 📧 **Email Notifications** - Send verification completion emails
- 👥 **Multi-tier Plans** - Free, Startup, Business, and Enterprise tiers
- 📱 **RESTful API** - Clean and intuitive API design
- 🧪 **Comprehensive Testing** - Jest test suite included

## 🛠️ Tech Stack

- **Runtime:** Node.js (>=14.0.0)
- **Framework:** Express.js
- **Database:** MongoDB with Mongoose
- **Cache/Queue:** Redis with Bull
- **Authentication:** JWT (jsonwebtoken)
- **Email:** Nodemailer
- **Payment:** Stripe
- **Monitoring:** Sentry, Winston, Prometheus
- **Testing:** Jest, Supertest

## 📋 Prerequisites

Before you begin, ensure you have the following installed:
- Node.js (>=14.0.0)
- MongoDB (>=4.0)
- Redis (>=6.0)
- npm or yarn

## 🚀 Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/email-verification-api.git
   cd email-verification-api/backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and configure the following variables (see Configuration section below).

4. **Start the server**
   ```bash
   # Development mode
   npm run server
   
   # Production mode
   npm start
   ```

5. **Start queue worker** (in a separate terminal)
   ```bash
   npm run queue:worker
   ```

## ⚙️ Configuration

Create a `.env` file in the root directory with the following variables:

### Required Variables

```env
# Server Configuration
NODE_ENV=development
PORT=3000
APP_URL=http://localhost:3000
APP_NAME=Email Verification API

# Database
MONGO_URI=mongodb://localhost:27017/email-verification-api

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# JWT Secret
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production

# Email Service (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-email-password
SMTP_FROM=noreply@yourapp.com
EMAIL_FROM=noreply@yourapp.com
```

### Optional Variables

```env
# Stripe (for billing)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_STARTUP_PRICE_ID=price_...
STRIPE_BUSINESS_PRICE_ID=price_...
STRIPE_ENTERPRISE_PRICE_ID=price_...

# Monitoring
SENTRY_DSN=https://...
SLACK_WEBHOOK_URL=https://hooks.slack.com/...

# Redis TLS (if using Redis Cloud)
REDIS_TLS_URL=rediss://...

# IP Rotation (for advanced use cases)
IP_POOL=ip1,ip2,ip3

# Queue Configuration
QUEUE_PREFIX=email-api
VERIFICATION_CONCURRENCY=20
BULK_VERIFICATION_CONCURRENCY=5

# CORS
ALLOWED_ORIGINS=http://localhost:3000,https://yourapp.com

# Logging
LOG_LEVEL=info
ENABLE_METRICS=true
```

## 📚 API Documentation

### Authentication

The API supports two authentication methods:
1. **JWT Token** - Send in `x-auth-token` header
2. **API Key** - Send in `x-api-key` header

### Base URL
```
http://localhost:3000/api/v1
```

### Endpoints

#### Authentication

##### Register User
```http
POST /api/auth/register
Content-Type: application/json

{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "securepassword123"
}
```

##### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "securepassword123"
}
```

Response:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "...",
    "name": "John Doe",
    "email": "john@example.com",
    "apiKey": "api_key_..."
  }
}
```

#### Email Verification

##### Verify Single Email
```http
POST /api/v1/verify
x-auth-token: your-jwt-token
Content-Type: application/json

{
  "email": "user@example.com",
  "skipCache": false,
  "advanced": false
}
```

Response:
```json
{
  "success": true,
  "data": {
    "email": "user@example.com",
    "isValid": true,
    "formatValid": true,
    "hasMx": true,
    "isDisposable": false,
    "smtpCheck": true,
    "domain": "example.com",
    "errors": []
  },
  "processingTime": 245
}
```

##### Enrich Email
```http
POST /api/v1/enrich
x-auth-token: your-jwt-token
Content-Type: application/json

{
  "email": "john.doe@example.com"
}
```

Response:
```json
{
  "success": true,
  "data": {
    "email": "john.doe@example.com",
    "isValid": true,
    "enrichment": {
      "possibleName": {
        "full": "John Doe",
        "first": "John",
        "last": "Doe"
      },
      "possibleCompany": "Example Inc",
      "isFreeProvider": false,
      "domainCategory": "standard"
    }
  }
}
```

##### Bulk Verify Emails
```http
POST /api/v1/bulk-verify
x-auth-token: your-jwt-token
Content-Type: application/json

{
  "emails": [
    "email1@example.com",
    "email2@example.com",
    "email3@example.com"
  ],
  "notifyUser": true
}
```

Response:
```json
{
  "success": true,
  "data": {
    "batchId": "batch_123456",
    "status": "queued",
    "totalEmails": 3,
    "estimatedCompletion": "2024-01-01T12:00:00Z"
  }
}
```

##### Get Bulk Verification Status
```http
GET /api/v1/bulk-verify/:batchId
x-auth-token: your-jwt-token
```

##### Download Bulk Results
```http
GET /api/v1/bulk-verify/:batchId/download?format=csv
x-auth-token: your-jwt-token
```

#### Usage & Statistics

##### Get Usage Statistics
```http
GET /api/v1/usage
x-auth-token: your-jwt-token
```

Response:
```json
{
  "success": true,
  "data": {
    "plan": "business",
    "currentMonth": {
      "count": 1250,
      "limit": 25000,
      "remaining": 23750
    },
    "totalVerifications": 15230
  }
}
```

### Error Responses

All errors follow this format:
```json
{
  "success": false,
  "message": "Error description",
  "error": "Detailed error message (in development)"
}
```

Common HTTP Status Codes:
- `200` - Success
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden (rate limit or usage limit exceeded)
- `404` - Not Found
- `429` - Too Many Requests
- `500` - Internal Server Error

## 📁 Project Structure

```
backend/
├── config/
│   ├── db.js              # MongoDB connection
│   └── queue.js            # Bull queue configuration
├── middleware/
│   ├── auth.js             # Basic authentication
│   └── security.js          # Enhanced security & rate limiting
├── models/
│   ├── User.js             # User model
│   ├── Usage.js            # Usage tracking model
│   ├── VerificationLog.js  # Verification history
│   └── BatchJob.js         # Bulk job tracking
├── routes/
│   ├── auth.js             # Authentication routes
│   ├── api.js              # Basic API routes
│   ├── production-api.js   # Production API routes
│   ├── billing.js          # Stripe billing routes
│   └── verification.js     # Email verification routes
├── utils/
│   ├── emailVerifier.js    # Basic email verification
│   ├── advancedEmailVerifier.js  # Advanced verification
│   ├── enhancedEmailVerifier.js  # Enhanced verification
│   ├── emailService.js     # Email sending service
│   ├── cache.js            # Redis caching utilities
│   ├── monitoring.js       # Logging & monitoring
│   └── disposableEmailDomains.js  # Disposable email list
├── workers/
│   └── queue-worker.js    # Background job processor
├── tests/
│   └── api.test.js        # API tests
├── logs/                   # Application logs
├── server.js               # Main server file
└── package.json
```

## 🧪 Testing

Run the test suite:
```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch
```

## 🔧 Development

### Running in Development Mode
```bash
npm run server
```

This uses `nodemon` to automatically restart the server on file changes.

### Queue Worker
Start the background job processor:
```bash
npm run queue:worker
```

### Linting
```bash
npm run lint
```

## 📊 Monitoring

The API includes comprehensive monitoring:

- **Sentry Integration** - Error tracking and reporting
- **Winston Logging** - Structured logging with multiple transports
- **Prometheus Metrics** - Performance and usage metrics
- **Slack Notifications** - Alert notifications (optional)

## 🔒 Security Features

- JWT token-based authentication
- API key authentication
- Rate limiting per IP and API key
- Request throttling
- Helmet.js security headers
- XSS protection
- SQL injection protection (MongoDB sanitization)
- CORS configuration
- Token blacklisting on logout

## 💳 Subscription Plans

The API supports multiple subscription tiers:

- **Free** - 100 verifications/month
- **Startup** - 5,000 verifications/month
- **Business** - 25,000 verifications/month
- **Enterprise** - Custom limits

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Development Guidelines

- Follow existing code style
- Write tests for new features
- Update documentation as needed
- Ensure all tests pass before submitting

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with [Express.js](https://expressjs.com/)
- Uses [MongoDB](https://www.mongodb.com/) for data storage
- [Redis](https://redis.io/) for caching and queues
- [Bull](https://github.com/OptimalBits/bull) for job processing
- [Stripe](https://stripe.com/) for payment processing

## 📞 Support

For support, email support@yourapp.com or open an issue in the repository.

## 🔗 Links

- [Documentation](https://docs.yourapp.com)
- [API Reference](https://api.yourapp.com/docs)
- [Issue Tracker](https://github.com/yourusername/email-verification-api/issues)

---

Made with ❤️ by [Your Name]
# email-verfication
# email-verification
