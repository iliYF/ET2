.PHONY: cf-pages clean

CUSTOM_PAGE_FILE ?= pages/et.html

cf-pages: clean
	CUSTOM_PAGE_FILE=$(CUSTOM_PAGE_FILE) node scripts/build-cf-pages.js

clean:
	rm -rf dist
