// Off Book's Azure environment (P2-01): staging only until launch, sized for the least cost; production
// will come from this same template with launch sizing (X-11).
//
// Deployed into an existing resource group by .github/workflows/deploy-staging.yml, with the values in
// staging.bicepparam. Everything secret lives in Key Vault; the app and the migration job read it with
// their managed identity, so no secret is set on either.
//
// One server process, always (D-01): live games are held in its memory, so the app is capped at one
// replica. Staging may scale to none when idle; the server saves every game on SIGTERM (P2-08).

targetScope = 'resourceGroup'

@description('Short name of the environment, used in every resource name.')
@allowed(['staging', 'production'])
param environmentName string

param location string = resourceGroup().location

@description('''The app image, server and client bundle together, e.g. ghcr.io/owner/off-book:<sha>. Empty
leaves the app out, so the first deploy can migrate the database before the server ever starts.''')
param serverImage string = ''

@description('The migration image (dbmate with db/migrations), e.g. ghcr.io/owner/off-book-migrate:<sha>.')
param migrateImage string

@description('Credentials for a private registry; leave empty when the images are public.')
param registryServer string = ''
param registryUsername string = ''
@secure()
param registryPassword string = ''

@description('Administrator of the PostgreSQL server. The app connects as this user until roles are split (X-08).')
param postgresAdminLogin string = 'offbook_admin'

@secure()
@description('Its password. Supplied by the deploy workflow from a GitHub secret, and kept in Key Vault.')
param postgresAdminPassword string

@description('PostgreSQL compute: Burstable B1ms is the cheapest tier that runs it.')
param postgresSkuName string = 'Standard_B1ms'
param postgresSkuTier string = 'Burstable'
param postgresStorageGb int = 32

@description('Fewest replicas of the app. 0 lets staging scale to none when idle, at the cost of a cold start.')
@minValue(0)
@maxValue(1)
param minReplicas int = 0

@description('Monthly spending limit for this resource group, in the subscription currency.')
param monthlyBudget int

@description('Who is emailed as spending approaches the budget.')
param budgetContactEmails array

@description('First day of the budget, the first of a month. Defaults to this month.')
param budgetStartDate string = '${utcNow('yyyy-MM')}-01'

var suffix = uniqueString(resourceGroup().id)
var name = 'offbook-${environmentName}'
var databaseName = 'off_book'
var tags = { app: 'off-book', environment: environmentName }

// Key Vault Secrets User, a built-in role: read secret values, nothing else.
var keyVaultSecretsUser = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${name}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    // A cap on ingestion, so a noisy bug cannot run up the bill.
    workspaceCapping: { dailyQuotaGb: json('0.2') }
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${name}'
  location: location
  tags: tags
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2026-10-01' = {
  name: 'psql-${name}-${suffix}'
  location: location
  tags: tags
  sku: { name: postgresSkuName, tier: postgresSkuTier }
  properties: {
    version: '18'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
    storage: { storageSizeGB: postgresStorageGb, autoGrow: 'Disabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    // Public endpoint, reachable only from Azure services and only over TLS. A private network costs
    // more than staging justifies; X-11 revisits it for production.
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2026-10-01' = {
  parent: postgres
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// 0.0.0.0 to 0.0.0.0 is Azure's convention for "services hosted in Azure", which includes Container Apps.
resource allowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2026-10-01' = {
  parent: postgres
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-${take(name, 10)}-${take(suffix, 8)}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    softDeleteRetentionInDays: 7
  }
}

resource databaseUrl 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'database-url'
  properties: {
    // sslmode=require: Azure refuses unencrypted connections; Node's pg also verifies the certificate.
    value: 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=require'
  }
}

resource readSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, keyVaultSecretsUser)
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsUser
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${name}'
  location: location
  tags: tags
  properties: {
    // Consumption only: billed per second of use, with a monthly free grant per subscription.
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var secrets = [
  {
    name: 'database-url'
    keyVaultUrl: databaseUrl.properties.secretUri
    identity: identity.id
  }
]
var registrySecrets = empty(registryServer) ? [] : [{ name: 'registry-password', value: registryPassword }]
var registries = empty(registryServer)
  ? []
  : [{ server: registryServer, username: registryUsername, passwordSecretRef: 'registry-password' }]

resource app 'Microsoft.App/containerApps@2024-03-01' = if (!empty(serverImage)) {
  name: 'ca-${name}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  dependsOn: [readSecrets]
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        // HTTP/1.1 with upgrades, for the game WebSocket.
        transport: 'http'
        allowInsecure: false
      }
      secrets: concat(secrets, registrySecrets)
      registries: registries
    }
    template: {
      // The server's clean shutdown gives the side to move 20 seconds and saves every game (P2-08).
      terminationGracePeriodSeconds: 60
      containers: [
        {
          name: 'server'
          image: serverImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [{ name: 'DATABASE_URL', secretRef: 'database-url' }]
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 8080 }, periodSeconds: 10 }
            { type: 'Readiness', httpGet: { path: '/health', port: 8080 }, periodSeconds: 5 }
            {
              type: 'Startup'
              httpGet: { path: '/health', port: 8080 }
              periodSeconds: 2
              failureThreshold: 30
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        // Never more than one: live games live in this process's memory (D-01).
        maxReplicas: 1
      }
    }
  }
}

// Applies db/migrations before each deploy; started by the workflow and run to completion.
resource migrate 'Microsoft.App/jobs@2024-03-01' = {
  name: 'job-${name}-migrate'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  dependsOn: [readSecrets, database, allowAzure]
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      secrets: concat(secrets, registrySecrets)
      registries: registries
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: migrateImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: [{ name: 'DATABASE_URL', secretRef: 'database-url' }]
        }
      ]
    }
  }
}

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'budget-${name}'
  properties: {
    category: 'Cost'
    amount: monthlyBudget
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      actual80: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: budgetContactEmails
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: budgetContactEmails
      }
    }
  }
}

output appName string = 'ca-${name}'
output appUrl string = empty(serverImage) ? '' : 'https://${app!.properties.configuration.ingress.fqdn}'
output migrateJobName string = migrate.name
output postgresServerName string = postgres.name
output keyVaultName string = vault.name
