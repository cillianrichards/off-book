// Staging, the only environment until launch (P2-01, X-11). Values marked PLACEHOLDER must be set
// before the first deploy; see "Deploying to staging" in the README. Images and the database password
// are passed by the deploy workflow, not kept here.
using 'main.bicep'

param environmentName = 'staging'

// Scale to none when idle: staging then costs almost nothing for the app, at the price of a cold start
// of a few seconds on the first request.
param minReplicas = 0

// The cheapest PostgreSQL that runs: Burstable B1ms, 32 GB. A new Azure account's free offer includes
// 750 hours a month of B1ms for its first year.
param postgresSkuName = 'Standard_B1ms'
param postgresSkuTier = 'Burstable'
param postgresStorageGb = 32

// PLACEHOLDER: a monthly limit in the subscription's currency, and who is warned as it nears.
param monthlyBudget = 20
param budgetContactEmails = ['PLACEHOLDER@example.com']

// Set by the deploy workflow on each run. SERVER_IMAGE is empty on the first deploy, which then creates
// everything but the app; the password comes from the POSTGRES_ADMIN_PASSWORD GitHub secret.
param serverImage = readEnvironmentVariable('SERVER_IMAGE', '')
param migrateImage = readEnvironmentVariable('MIGRATE_IMAGE')
param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD')

// Only for a private registry; public images need none of these.
param registryServer = readEnvironmentVariable('REGISTRY_SERVER', '')
param registryUsername = readEnvironmentVariable('REGISTRY_USERNAME', '')
param registryPassword = readEnvironmentVariable('REGISTRY_PASSWORD', '')
