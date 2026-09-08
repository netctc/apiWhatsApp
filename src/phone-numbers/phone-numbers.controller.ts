import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { CreatePhoneNumberDto } from "./dto/create-phone-number.dto.js";
import { UpdatePhoneNumberDto } from "./dto/update-phone-number.dto.js";
import { PhoneNumbersService } from "./phone-numbers.service.js";

@ApiTags("phone-numbers")
@ApiSecurity("apiKey")
@Controller("v1/phone-numbers")
export class PhoneNumbersController {
  constructor(private readonly phoneNumbersService: PhoneNumbersService) {}

  @Post()
  @RequireScopes(ApiScope.PHONE_NUMBERS_WRITE)
  create(@CurrentPrincipal() principal: ApiPrincipal, @Body() dto: CreatePhoneNumberDto) {
    return this.phoneNumbersService.create(principal.tenantId, dto);
  }

  @Get()
  @RequireScopes(ApiScope.PHONE_NUMBERS_READ)
  list(@CurrentPrincipal() principal: ApiPrincipal) {
    return this.phoneNumbersService.list(principal.tenantId);
  }

  @Get(":id")
  @RequireScopes(ApiScope.PHONE_NUMBERS_READ)
  findById(@CurrentPrincipal() principal: ApiPrincipal, @Param("id") id: string) {
    return this.phoneNumbersService.findById(principal.tenantId, id);
  }

  @Patch(":id")
  @RequireScopes(ApiScope.PHONE_NUMBERS_WRITE)
  update(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id") id: string,
    @Body() dto: UpdatePhoneNumberDto,
  ) {
    return this.phoneNumbersService.update(principal.tenantId, id, dto);
  }
}
