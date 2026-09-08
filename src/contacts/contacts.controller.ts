import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiScope } from "../auth/auth.constants.js";
import type { ApiPrincipal } from "../auth/auth.types.js";
import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { ContactsService } from "./contacts.service.js";
import { CreateContactDto } from "./dto/create-contact.dto.js";
import { RecordConsentDto } from "./dto/record-consent.dto.js";
import { UpdateContactDto } from "./dto/update-contact.dto.js";

@ApiTags("contacts")
@ApiSecurity("apiKey")
@Controller("v1/contacts")
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Post()
  @RequireScopes(ApiScope.CONTACTS_WRITE)
  create(@CurrentPrincipal() principal: ApiPrincipal, @Body() dto: CreateContactDto) {
    return this.contactsService.create(principal.tenantId, dto);
  }

  @Get()
  @RequireScopes(ApiScope.CONTACTS_READ)
  list(@CurrentPrincipal() principal: ApiPrincipal) {
    return this.contactsService.list(principal.tenantId);
  }

  @Get(":id")
  @RequireScopes(ApiScope.CONTACTS_READ)
  findById(@CurrentPrincipal() principal: ApiPrincipal, @Param("id") id: string) {
    return this.contactsService.findById(principal.tenantId, id);
  }

  @Patch(":id")
  @RequireScopes(ApiScope.CONTACTS_WRITE)
  update(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id") id: string,
    @Body() dto: UpdateContactDto,
  ) {
    return this.contactsService.update(principal.tenantId, id, dto);
  }

  @Post(":id/consents")
  @RequireScopes(ApiScope.CONTACTS_WRITE)
  recordConsent(
    @CurrentPrincipal() principal: ApiPrincipal,
    @Param("id") id: string,
    @Body() dto: RecordConsentDto,
  ) {
    return this.contactsService.recordConsent(principal.tenantId, id, dto);
  }

  @Get(":id/consents")
  @RequireScopes(ApiScope.CONTACTS_READ)
  listConsentEvents(@CurrentPrincipal() principal: ApiPrincipal, @Param("id") id: string) {
    return this.contactsService.listConsentEvents(principal.tenantId, id);
  }
}
