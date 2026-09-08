import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/public.decorator.js";

@Public()
@Controller("health")
export class HealthController {
  @Get()
  getHealth(): { status: string; timestamp: string } {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }
}
