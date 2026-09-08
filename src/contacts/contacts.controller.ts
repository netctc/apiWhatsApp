import { Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ApiKeyGuard } from "../auth/api-key.guard.js";
import { CurrentTenantId } from "../auth/current-tenant.decorator.js";
import { RequireScopes } from "../auth/require-scopes.decorator.js";
import { ScopesGuard } from "../auth/scopes.guard.js";
import { ContactsService } from "./contacts.service.js";
import { CreateContactDto } from "./dto/create-contact.dto.js";
import { RecordConsentDto } from "./dto/record-consent.dto.js";

@ApiTags("contacts")
@ApiBearerAuth("api-key")
@UseGuards(ApiKeyGuard, ScopesGuard)
@Controller("v1/contacts")
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Post()
  @RequireScopes("contacts:write")
  @ApiOperation({ summary: "Create a tenant-owned WhatsApp contact" })
  create(@CurrentTenantId() tenantId: string, @Body() dto: CreateContactDto) {
    return this.contacts.create(tenantId, dto);
  }

  @Get()
  @RequireScopes("contacts:read")
  @ApiOperation({ summary: "List tenant-owned contacts or look up an exact phone number" })
  findAll(@CurrentTenantId() tenantId: string, @Query("phone") phone?: string) {
    return this.contacts.findAll(tenantId, phone);
  }

  @Get(":id")
  @RequireScopes("contacts:read")
  @ApiOperation({ summary: "Get a tenant-owned contact and recent consent history" })
  async findById(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    const contact = await this.contacts.findById(tenantId, id);
    if (!contact) {
      throw new NotFoundException("Contact not found");
    }
    return contact;
  }

  @Post(":id/consent")
  @RequireScopes("consent:write")
  @ApiOperation({ summary: "Record an auditable WhatsApp consent state change" })
  recordConsent(
    @CurrentTenantId() tenantId: string,
    @Param("id") id: string,
    @Body() dto: RecordConsentDto,
  ) {
    return this.contacts.recordConsent(tenantId, id, dto);
  }
}
