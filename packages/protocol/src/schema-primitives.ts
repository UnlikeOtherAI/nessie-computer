import { z } from 'zod'

export const TimestampSchema = z.string().min(1)
export const NonEmptyStringSchema = z.string().min(1)

export const createUuidBrandSchema = <TBrand extends string>() =>
  z.string().uuid().brand<TBrand>()
