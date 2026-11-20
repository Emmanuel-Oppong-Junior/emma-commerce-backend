import { registerEnumType } from '@nestjs/graphql';

export enum AttributeDataTypeEnum {
  TEXT = 'TEXT',
  NUMBER = 'NUMBER',
  BOOLEAN = 'BOOLEAN',
}

registerEnumType(AttributeDataTypeEnum, {
  name: 'AttributeDataType',
  description: 'Type of an attribute value: TEXT, NUMBER (in the attribute unit) or BOOLEAN',
});
