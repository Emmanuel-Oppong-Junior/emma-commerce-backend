-- AddUniqueConstraint: Enforce subcategory name uniqueness within a parent category
ALTER TABLE "SubCategory" ADD CONSTRAINT "SubCategory_name_categoryId_key" UNIQUE ("name", "categoryId");
