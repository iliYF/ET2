.PHONY: clean

CUSTOM_PAGE_FILE ?= pages/et.html
ARCHIVE_NAME ?= et-cf-pages.zip

## archive cf -pages
cf-pages: clean
	CUSTOM_PAGE_FILE=$(CUSTOM_PAGE_FILE) node scripts/build-cf-pages.js
	mkdir -p output
	cd dist && zip -r ../output/$(ARCHIVE_NAME) .

## 本地开发
dev:
	npx wrangler dev

## 部署到 Workers（自动打包 src/index.js）
deploy:
	npx wrangler deploy

## 部署到 Cloudflare Pages
deploy-pages:
	npx wrangler pages deploy .

## 清理（保留，无实际需要）
clean:
	rm -rf dist output

build: clean
	echo "Build ..."
	npm run build

dist: build
	echo "Dist ..."

preview:
	npm run start

deploy:
	npm run deploy

deploy-pages:
	npm run deploy:pages
