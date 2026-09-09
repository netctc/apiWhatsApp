import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle("apiWhatsApp")
    .setDescription("Enterprise WhatsApp Business Platform API")
    .setVersion("0.10.0")
    .addApiKey(
      {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
        description: "Tenant API key. Raw keys are shown only when provisioned.",
      },
      "apiKey",
    )
    .build();

  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swaggerConfig));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, "0.0.0.0");
}

void bootstrap();
