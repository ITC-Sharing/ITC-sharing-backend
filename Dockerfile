FROM node:20-alpine
# LibreOffice (headless) converts office uploads (pptx/docx/xlsx) to PDF for
# in-browser preview; ttf-* fonts keep the rendered PDFs from falling back to
# tofu for common Latin text. OfficeConvertService shells out to `soffice`.
RUN apk add --no-cache libreoffice ttf-freefont ttf-dejavu
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev"]
