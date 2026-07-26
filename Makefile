.PHONY: cf-pages clean

CUSTOM_PAGE_FILE ?= pages/et.html
ARCHIVE_NAME ?= et-cf-pages.zip

cf-pages: clean
	CUSTOM_PAGE_FILE=$(CUSTOM_PAGE_FILE) node scripts/build-cf-pages.js
	mkdir -p output
	cd dist && zip -r ../output/$(ARCHIVE_NAME) .

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
