import { NestFactory } from '@nestjs/core'
import { ConsoleLogger } from '@nestjs/common'
import { apiReference } from '@scalar/nestjs-api-reference'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'

import { AppModule } from './app.module'

import { env } from './infra/config/env'
import { CollectionScheduler } from './modules/kuantokusta/services/collection.scheduler'
import { CollectionWorker } from './modules/kuantokusta/services/collection.worker'

const production = env.NODE_ENV === 'production'

// No CORS: the only client today is the WordPress plugin, which calls from
// its server, not from a browser. When the admin panel exists, its exact
// origin is allowed here. Never `*` together with credentials.
const app = await NestFactory.create(AppModule, {
  // One JSON object per line in production, so the host's log search can
  // filter on fields.
  logger: new ConsoleLogger({ json: production })
})

// Lets Nest run the shutdown hooks on SIGTERM, when the host stops or
// redeploys the service: the collection puts its run back in the queue,
// then the database pool is closed.
app.enableShutdownHooks()

// The API reference describes every route. It is served in development only,
// so the public address does not hand a map of the API to strangers.
if (!production) {
  const config = new DocumentBuilder()
    .setTitle('Pharma Hub API')
    .setDescription(
      'Integration hub for pharmacy stores. Version 1: KuantoKusta prices.'
    )
    .setVersion('0.1.0')
    .setOpenAPIVersion('3.1.1')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      description: 'A plugin token, issued per store'
    })
    .build()

  const document = SwaggerModule.createDocument(app, config)

  app.use(
    '/docs',
    apiReference({
      theme: 'purple',
      content: document
    })
  )
}

await app.listen(env.PORT, '0.0.0.0')

// The price collection runs inside this process: one worker that carries out
// the collections waiting in the database, and a clock that asks for one per
// day when a time is configured. Started here and nowhere else, so an
// operator command or a test never starts a second worker.
app.get(CollectionWorker).start()
app.get(CollectionScheduler).start(env.KK_COLLECTION_DAILY_AT)
